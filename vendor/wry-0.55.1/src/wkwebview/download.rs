use std::{env::current_dir, path::PathBuf, ptr::null_mut};

#[cfg(target_os = "macos")]
type DownloadCompletionObserver = Box<dyn FnOnce(String, PathBuf, bool) + Send>;
#[cfg(target_os = "macos")]
type DownloadCompletionObservers = std::collections::BTreeMap<PathBuf, DownloadCompletionObserver>;
#[cfg(target_os = "macos")]
static DOWNLOAD_COMPLETION_OBSERVERS: std::sync::OnceLock<
  std::sync::Mutex<DownloadCompletionObservers>,
> = std::sync::OnceLock::new();

/// Register one terminal observer for an application's unique download stage.
///
/// The observer survives removal of the originating WebView. It runs once on
/// the native terminal callback, before the ordinary completion handler. The
/// destination must never be reused while its download can still write.
/// Duplicate destinations and exhausted capacity are refused without replacing
/// another observer. A download without a terminal callback retains its bounded
/// entry; registration alone does not establish cancellation or file ownership.
#[cfg(target_os = "macos")]
pub fn register_download_completion_observer(
  destination: &std::path::Path,
  observer: impl FnOnce(String, PathBuf, bool) + Send + 'static,
) -> Result<(), &'static str> {
  if !destination.is_absolute() {
    return Err("download completion observer requires an absolute stage path");
  }
  let mut observers = DOWNLOAD_COMPLETION_OBSERVERS
    .get_or_init(Default::default)
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  if observers.contains_key(destination) {
    return Err("download completion observer already owns this stage");
  }
  if observers.len() >= 1024 {
    return Err("download completion observer capacity exhausted");
  }
  observers.insert(destination.to_path_buf(), Box::new(observer));
  Ok(())
}

use objc2::{rc::Retained, runtime::ProtocolObject, DeclaredClass};
use objc2_foundation::{NSData, NSError, NSString, NSURLResponse, NSURL};
use objc2_web_kit::{WKDownload, WKNavigationAction, WKNavigationResponse};

#[cfg(target_os = "ios")]
use crate::wkwebview::ios::WKWebView::WKWebView;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

#[cfg(target_os = "macos")]
use super::class::wry_download_delegate::TerminalDownload;
use super::class::{
  wry_download_delegate::WryDownloadDelegate, wry_navigation_delegate::WryNavigationDelegate,
};

// Download action handler
pub(crate) fn navigation_download_action(
  this: &WryNavigationDelegate,
  _webview: &WKWebView,
  _action: &WKNavigationAction,
  download: &WKDownload,
) {
  unsafe {
    if let Some(delegate) = &this.ivars().download_delegate {
      let proto_delegate = ProtocolObject::from_ref(&**delegate);
      download.setDelegate(Some(proto_delegate));
    }
  }
}

// Download response handler
pub(crate) fn navigation_download_response(
  this: &WryNavigationDelegate,
  _webview: &WKWebView,
  _response: &WKNavigationResponse,
  download: &WKDownload,
) {
  unsafe {
    if let Some(delegate) = &this.ivars().download_delegate {
      let proto_delegate = ProtocolObject::from_ref(&**delegate);
      download.setDelegate(Some(proto_delegate));
    }
  }
}

pub(crate) fn download_policy(
  this: &WryDownloadDelegate,
  download: &WKDownload,
  _response: &NSURLResponse,
  suggested_filename: &NSString,
  completion_handler: &block2::Block<dyn Fn(*const NSURL)>,
) {
  unsafe {
    let request = download.originalRequest().unwrap();
    let url = request.URL().unwrap().absoluteString().unwrap();
    let suggested_filename = suggested_filename.to_string();
    let mut download_destination =
      dirs::download_dir().unwrap_or_else(|| current_dir().unwrap_or_default());

    download_destination.push(&suggested_filename);

    let (suggested_filename, ext) = suggested_filename
      .split_once('.')
      .map(|(base, ext)| (base, format!(".{ext}")))
      .unwrap_or((&suggested_filename, "".to_string()));

    // WebView2 does not overwrite files but appends numbers
    let mut counter = 1;
    while download_destination.exists() {
      download_destination.set_file_name(format!("{suggested_filename} ({counter}){ext}"));
      counter += 1;
    }

    if let Some(started_fn) = &this.ivars().started {
      let accepted = {
        let mut started_fn = started_fn.borrow_mut();
        started_fn(url.to_string(), &mut download_destination)
      };
      if accepted {
        #[cfg(target_os = "macos")]
        this.track_accepted_download(download, url.to_string(), download_destination.clone());
        let path = NSString::from_str(&download_destination.display().to_string());
        let ns_url = NSURL::fileURLWithPath_isDirectory(&path, false);
        (*completion_handler).call((Retained::as_ptr(&ns_url),));
      } else {
        (*completion_handler).call((null_mut(),));
      }
    } else {
      #[cfg(feature = "tracing")]
      tracing::warn!("WebView instance is dropped! This navigation handler shouldn't be called.");
      (*completion_handler).call((null_mut(),));
    }
  }
}

fn notify_download_terminal(
  this: &WryDownloadDelegate,
  url: String,
  path: Option<PathBuf>,
  success: bool,
) {
  #[cfg(target_os = "macos")]
  if let Some(destination) = path.as_ref() {
    let observer = DOWNLOAD_COMPLETION_OBSERVERS.get().and_then(|observers| {
      observers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(destination)
    });
    if let Some(observer) = observer {
      // Release the registry lock before application code can reenter Wry.
      observer(url.clone(), destination.clone(), success);
    }
  }
  if let Some(completed_fn) = this.ivars().completed.clone() {
    completed_fn(url, path, success);
  }
}

#[cfg(target_os = "macos")]
pub(crate) fn download_cancelled(this: &WryDownloadDelegate, identity: *const WKDownload) {
  if let Some((url, destination)) = this.acknowledge_download_cancellation(identity) {
    notify_download_terminal(this, url, Some(destination), false);
  }
}

pub(crate) fn download_did_finish(this: &WryDownloadDelegate, download: &WKDownload) {
  #[cfg(target_os = "macos")]
  match this.terminal_download(download) {
    TerminalDownload::Accepted(url, destination) => {
      return notify_download_terminal(this, url, Some(destination), true)
    }
    TerminalDownload::CancelPending(url, destination) => {
      return notify_download_terminal(this, url, Some(destination), false)
    }
    TerminalDownload::Untracked => {}
  }

  unsafe {
    let original_request = download.originalRequest().unwrap();
    let url = original_request.URL().unwrap().absoluteString().unwrap();
    notify_download_terminal(this, url.to_string(), None, true);
  }
}

pub(crate) fn download_did_fail(
  this: &WryDownloadDelegate,
  download: &WKDownload,
  error: &NSError,
  _resume_data: &NSData,
) {
  #[cfg(debug_assertions)]
  unsafe {
    let description = error.localizedDescription().to_string();
    eprintln!("Download failed with error: {description}");
  }

  #[cfg(target_os = "macos")]
  match this.terminal_download(download) {
    TerminalDownload::Accepted(url, destination)
    | TerminalDownload::CancelPending(url, destination) => {
      return notify_download_terminal(this, url, Some(destination), false);
    }
    TerminalDownload::Untracked => {}
  }

  unsafe {
    let original_request = download.originalRequest().unwrap();
    let url = original_request.URL().unwrap().absoluteString().unwrap();
    notify_download_terminal(this, url.to_string(), None, false);
  }
}
