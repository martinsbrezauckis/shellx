//! Serialize native Windows download adapter observations.

use serde_json::json;

pub(super) fn windows_native_download_adapter_observation_json(
    event: wry::WindowsDownloadAdapterEvent,
) -> serde_json::Value {
    use wry::{
        WindowsDownloadAdapterDelayedStatePollUnavailableReason, WindowsDownloadAdapterEvent,
        WindowsDownloadAdapterObservationSource, WindowsDownloadAdapterState,
        WindowsDownloadInterruptReason,
    };

    match event {
        WindowsDownloadAdapterEvent::ObserverRegistrationUnavailable => {
            json!({ "event": "observerRegistrationUnavailable" })
        }
        WindowsDownloadAdapterEvent::StateHandlerRegistered => {
            json!({ "event": "stateHandlerRegistered" })
        }
        WindowsDownloadAdapterEvent::StateHandlerUnavailable => {
            json!({ "event": "stateHandlerUnavailable" })
        }
        WindowsDownloadAdapterEvent::DownloadStartingHandlerAccepted => {
            json!({ "event": "downloadStartingHandlerAccepted" })
        }
        WindowsDownloadAdapterEvent::ResultFilePathSet => {
            json!({ "event": "resultFilePathSet" })
        }
        WindowsDownloadAdapterEvent::ResultFilePathSetFailed { hresult } => {
            json!({ "event": "resultFilePathSetFailed", "hresult": hresult })
        }
        WindowsDownloadAdapterEvent::HandledSet => json!({ "event": "handledSet" }),
        WindowsDownloadAdapterEvent::HandledSetFailed { hresult } => {
            json!({ "event": "handledSetFailed", "hresult": hresult })
        }
        WindowsDownloadAdapterEvent::DelayedStatePollScheduled { operation_id } => {
            json!({ "event": "delayedStatePollScheduled", "operationId": operation_id })
        }
        WindowsDownloadAdapterEvent::DelayedStatePollUnavailable {
            operation_id,
            reason,
        } => json!({
            "event": "delayedStatePollUnavailable",
            "operationId": operation_id,
            "reason": match reason {
                WindowsDownloadAdapterDelayedStatePollUnavailableReason::Capacity => "capacity",
                WindowsDownloadAdapterDelayedStatePollUnavailableReason::TimerRejected => "timerRejected",
                WindowsDownloadAdapterDelayedStatePollUnavailableReason::TimerCollision => "timerCollision",
            },
        }),
        WindowsDownloadAdapterEvent::StateCallbackOperationMissing => {
            json!({ "event": "stateCallbackOperationMissing" })
        }
        WindowsDownloadAdapterEvent::StateReadFailed { source, hresult } => json!({
            "event": "stateReadFailed",
            "source": match source {
                WindowsDownloadAdapterObservationSource::PostHandled => "postHandled",
                WindowsDownloadAdapterObservationSource::StateChanged => "stateChanged",
                WindowsDownloadAdapterObservationSource::DelayedStatePoll => "delayedStatePoll",
            },
            "hresult": hresult,
        }),
        WindowsDownloadAdapterEvent::TotalBytesToReceiveReadFailed { source, hresult } => json!({
            "event": "totalBytesToReceiveReadFailed",
            "source": match source {
                WindowsDownloadAdapterObservationSource::PostHandled => "postHandled",
                WindowsDownloadAdapterObservationSource::StateChanged => "stateChanged",
                WindowsDownloadAdapterObservationSource::DelayedStatePoll => "delayedStatePoll",
            },
            "hresult": hresult,
        }),
        WindowsDownloadAdapterEvent::BytesReceivedReadFailed { source, hresult } => json!({
            "event": "bytesReceivedReadFailed",
            "source": match source {
                WindowsDownloadAdapterObservationSource::PostHandled => "postHandled",
                WindowsDownloadAdapterObservationSource::StateChanged => "stateChanged",
                WindowsDownloadAdapterObservationSource::DelayedStatePoll => "delayedStatePoll",
            },
            "hresult": hresult,
        }),
        WindowsDownloadAdapterEvent::InterruptReasonReadFailed { source, hresult } => json!({
            "event": "interruptReasonReadFailed",
            "source": match source {
                WindowsDownloadAdapterObservationSource::PostHandled => "postHandled",
                WindowsDownloadAdapterObservationSource::StateChanged => "stateChanged",
                WindowsDownloadAdapterObservationSource::DelayedStatePoll => "delayedStatePoll",
            },
            "hresult": hresult,
        }),
        WindowsDownloadAdapterEvent::CanResumeReadFailed { source, hresult } => json!({
            "event": "canResumeReadFailed",
            "source": match source {
                WindowsDownloadAdapterObservationSource::PostHandled => "postHandled",
                WindowsDownloadAdapterObservationSource::StateChanged => "stateChanged",
                WindowsDownloadAdapterObservationSource::DelayedStatePoll => "delayedStatePoll",
            },
            "hresult": hresult,
        }),
        WindowsDownloadAdapterEvent::StateObserved {
            source,
            operation_id,
            state,
            total_bytes_to_receive,
            bytes_received,
            interrupt_reason,
            can_resume,
        } => json!({
            "event": "stateObserved",
            "source": match source {
                WindowsDownloadAdapterObservationSource::PostHandled => "postHandled",
                WindowsDownloadAdapterObservationSource::StateChanged => "stateChanged",
                WindowsDownloadAdapterObservationSource::DelayedStatePoll => "delayedStatePoll",
            },
            "operationId": operation_id,
            "state": match state {
                WindowsDownloadAdapterState::InProgress => "inProgress",
                WindowsDownloadAdapterState::Interrupted => "interrupted",
                WindowsDownloadAdapterState::Completed => "completed",
                WindowsDownloadAdapterState::Unknown(_) => "unknown",
            },
            "stateCode": match state {
                WindowsDownloadAdapterState::Unknown(code) => Some(code),
                _ => None,
            },
            "totalBytesToReceive": total_bytes_to_receive,
            "bytesReceived": bytes_received,
            "interruptReason": interrupt_reason.map(|reason| match reason {
                WindowsDownloadInterruptReason::None => "none",
                WindowsDownloadInterruptReason::FileFailed => "fileFailed",
                WindowsDownloadInterruptReason::FileAccessDenied => "fileAccessDenied",
                WindowsDownloadInterruptReason::FileNoSpace => "fileNoSpace",
                WindowsDownloadInterruptReason::FileNameTooLong => "fileNameTooLong",
                WindowsDownloadInterruptReason::FileTooLarge => "fileTooLarge",
                WindowsDownloadInterruptReason::FileMalicious => "fileMalicious",
                WindowsDownloadInterruptReason::FileTransientError => "fileTransientError",
                WindowsDownloadInterruptReason::FileBlockedByPolicy => "fileBlockedByPolicy",
                WindowsDownloadInterruptReason::FileSecurityCheckFailed => "fileSecurityCheckFailed",
                WindowsDownloadInterruptReason::FileTooShort => "fileTooShort",
                WindowsDownloadInterruptReason::FileHashMismatch => "fileHashMismatch",
                WindowsDownloadInterruptReason::NetworkFailed => "networkFailed",
                WindowsDownloadInterruptReason::NetworkTimeout => "networkTimeout",
                WindowsDownloadInterruptReason::NetworkDisconnected => "networkDisconnected",
                WindowsDownloadInterruptReason::NetworkServerDown => "networkServerDown",
                WindowsDownloadInterruptReason::NetworkInvalidRequest => "networkInvalidRequest",
                WindowsDownloadInterruptReason::ServerFailed => "serverFailed",
                WindowsDownloadInterruptReason::ServerNoRange => "serverNoRange",
                WindowsDownloadInterruptReason::ServerBadContent => "serverBadContent",
                WindowsDownloadInterruptReason::ServerUnauthorized => "serverUnauthorized",
                WindowsDownloadInterruptReason::ServerCertificateProblem => "serverCertificateProblem",
                WindowsDownloadInterruptReason::ServerForbidden => "serverForbidden",
                WindowsDownloadInterruptReason::ServerUnexpectedResponse => "serverUnexpectedResponse",
                WindowsDownloadInterruptReason::ServerContentLengthMismatch => "serverContentLengthMismatch",
                WindowsDownloadInterruptReason::ServerCrossOriginRedirect => "serverCrossOriginRedirect",
                WindowsDownloadInterruptReason::UserCanceled => "userCanceled",
                WindowsDownloadInterruptReason::UserShutdown => "userShutdown",
                WindowsDownloadInterruptReason::UserPaused => "userPaused",
                WindowsDownloadInterruptReason::Unknown(_) => "unknown",
            }),
            "interruptReasonCode": interrupt_reason.and_then(|reason| match reason {
                WindowsDownloadInterruptReason::Unknown(code) => Some(code),
                _ => None,
            }),
            "canResume": can_resume,
        }),
        WindowsDownloadAdapterEvent::CompletionHandlerInvoked { success } => {
            json!({ "event": "completionHandlerInvoked", "success": success })
        }
    }
}
