use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::time::{timeout, Duration};
use tracing::{debug, error};

use super::GrokAcpSession;

const GROK_INTERJECT_METHOD: &str = "_x.ai/interject";
const GROK_INTERJECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Debug)]
pub(super) struct AcpRequest<T> {
    pub(super) jsonrpc: String,
    pub(super) id: u64,
    pub(super) method: String,
    pub(super) params: T,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GrokInterjectParams {
    session_id: String,
    text: String,
    interjection_id: String,
}

/// Correlation guard for an in-flight ACP request.
///
/// Prompt callers commonly wrap this future in `tokio::time::timeout` so
/// `/abort` can acquire the session lock while a long turn is running.  If a
/// polled guard is cancelled or times out, `Drop` evicts its correlation slot
/// instead of leaving a dead sender in `pending_responses` until process exit.
/// A never-polled guard is intentionally treated as fire-and-forget: build and
/// goal continuation paths rely on the reader retaining the slot so it can
/// observe the eventual response and synthesize prompt-complete when needed.
pub(super) struct PendingAcpRequest {
    pub(super) method: String,
    pub(super) sender: oneshot::Sender<serde_json::Value>,
}

pub struct PendingAcpResponse {
    id: u64,
    method: String,
    request_timeout: Duration,
    receiver: oneshot::Receiver<serde_json::Value>,
    pending_responses: Arc<TokioMutex<HashMap<u64, PendingAcpRequest>>>,
    polled: bool,
}

impl PendingAcpResponse {
    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    pub(crate) async fn wait(self) -> Result<serde_json::Value, String> {
        let request_timeout = self.request_timeout;
        let method = self.method.clone();
        match timeout(request_timeout, self).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "ACP request timeout for {} (no response in {}s)",
                method,
                request_timeout.as_secs()
            )),
        }
    }
}

impl Future for PendingAcpResponse {
    type Output = Result<serde_json::Value, String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.polled = true;
        match Pin::new(&mut self.receiver).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(_)) => Poll::Ready(Err(
                "ACP response channel closed (process died?)".to_string()
            )),
            Poll::Ready(Ok(response)) => {
                if let Some(err) = response.get("error").filter(|err| !err.is_null()) {
                    error!("ACP request {} error: {:?}", self.method, err);
                    Poll::Ready(Err(format!("ACP error for {}: {:?}", self.method, err)))
                } else {
                    Poll::Ready(Ok(response.get("result").cloned().unwrap_or(response)))
                }
            }
        }
    }
}

impl Drop for PendingAcpResponse {
    fn drop(&mut self) {
        if !self.polled {
            return;
        }

        if let Ok(mut pending) = self.pending_responses.try_lock() {
            pending.remove(&self.id);
            return;
        }

        let pending_responses = self.pending_responses.clone();
        let id = self.id;
        tokio::spawn(async move {
            pending_responses.lock().await.remove(&id);
        });
    }
}

impl GrokAcpSession {
    pub(crate) async fn initiate_interject_prompt(
        &self,
        text: &str,
    ) -> Result<(String, PendingAcpResponse), String> {
        if text.trim().is_empty() {
            return Err("Empty interjection".to_string());
        }
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| "No active session".to_string())?;
        let interjection_id = uuid::Uuid::new_v4().to_string();
        let params = GrokInterjectParams {
            session_id,
            text: text.to_string(),
            interjection_id: interjection_id.clone(),
        };

        let response = self
            .initiate_request(GROK_INTERJECT_METHOD, params, GROK_INTERJECT_TIMEOUT)
            .await?;
        Ok((interjection_id, response))
    }

    pub(super) async fn send_request<T: Serialize>(
        &self,
        method: &str,
        params: T,
    ) -> Result<serde_json::Value, String> {
        self.send_request_with_timeout(method, params, Duration::from_secs(600))
            .await
    }

    async fn send_request_with_timeout<T: Serialize>(
        &self,
        method: &str,
        params: T,
        request_timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.initiate_request(method, params, request_timeout)
            .await?
            .wait()
            .await
    }

    pub(super) async fn initiate_request<T: Serialize>(
        &self,
        method: &str,
        params: T,
        request_timeout: Duration,
    ) -> Result<PendingAcpResponse, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        self.pending_responses.lock().await.insert(
            id,
            PendingAcpRequest {
                method: method.to_string(),
                sender: tx,
            },
        );

        let request = AcpRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };
        let json = match serde_json::to_string(&request) {
            Ok(json) => json,
            Err(err) => {
                self.pending_responses.lock().await.remove(&id);
                return Err(err.to_string());
            }
        };
        let line = format!("{}\n", json);

        let write_result = if let Some(stdin_arc) = &self.stdin {
            let mut stdin = stdin_arc.lock().await;
            match stdin.write_all(line.as_bytes()).await {
                Ok(()) => stdin.flush().await.map_err(|err| err.to_string()),
                Err(err) => Err(err.to_string()),
            }
        } else {
            Err("No active stdin writer".to_string())
        };
        if let Err(err) = write_result {
            self.pending_responses.lock().await.remove(&id);
            return Err(err);
        }
        debug!("ACP sent request id={} method={}", id, method);
        Ok(PendingAcpResponse {
            id,
            method: method.to_string(),
            request_timeout,
            receiver: rx,
            pending_responses: self.pending_responses.clone(),
            polled: false,
        })
    }
}

#[cfg(test)]
#[path = "../public/tests/inline/acp_requests/tests.rs"]
mod tests;
