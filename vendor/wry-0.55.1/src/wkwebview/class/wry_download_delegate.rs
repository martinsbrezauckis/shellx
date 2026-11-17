// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{cell::RefCell, path::PathBuf, rc::Rc};

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::Message;
use objc2::{
  define_class, msg_send, rc::Retained, runtime::NSObject, DefinedClass, MainThreadOnly,
};
use objc2_foundation::{
  MainThreadMarker, NSData, NSError, NSObjectProtocol, NSString, NSURLResponse, NSURL,
};
use objc2_web_kit::{WKDownload, WKDownloadDelegate};

#[cfg(target_os = "macos")]
use crate::wkwebview::download::download_cancelled;
use crate::wkwebview::download::{download_did_fail, download_did_finish, download_policy};

#[cfg(target_os = "macos")]
struct AcceptedDownload {
  download: Retained<WKDownload>,
  url: String,
  destination: PathBuf,
}

#[cfg(target_os = "macos")]
struct CancelPendingDownload {
  // Keep the exact native controller alive until its cancellation completion
  // or terminal delegate callback consumes this record. The completion also
  // retains the delegate, so this is a temporary cycle broken by either exact
  // terminal path; no callback leaves it pending rather than inventing an ack.
  download: Retained<WKDownload>,
  url: String,
  destination: PathBuf,
}

#[cfg(target_os = "macos")]
pub(crate) enum TerminalDownload {
  Accepted(String, PathBuf),
  CancelPending(String, PathBuf),
  Untracked,
}

pub struct WryDownloadDelegateIvars {
  pub started: Option<RefCell<Box<dyn FnMut(String, &mut PathBuf) -> bool + 'static>>>,
  pub completed: Option<Rc<dyn Fn(String, Option<PathBuf>, bool) + 'static>>,
  #[cfg(target_os = "macos")]
  accepted_downloads: RefCell<Vec<AcceptedDownload>>,
  #[cfg(target_os = "macos")]
  cancel_pending_downloads: RefCell<Vec<CancelPendingDownload>>,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[thread_kind = MainThreadOnly]
  #[ivars = WryDownloadDelegateIvars]
  pub struct WryDownloadDelegate;

  unsafe impl NSObjectProtocol for WryDownloadDelegate {}

  unsafe impl WKDownloadDelegate for WryDownloadDelegate {
    #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
    fn download_policy(
      &self,
      download: &WKDownload,
      response: &NSURLResponse,
      suggested_filename: &NSString,
      handler: &block2::Block<dyn Fn(*const NSURL)>,
    ) {
      download_policy(self, download, response, suggested_filename, handler);
    }

    #[unsafe(method(downloadDidFinish:))]
    fn download_did_finish(&self, download: &WKDownload) {
      download_did_finish(self, download);
    }

    #[unsafe(method(download:didFailWithError:resumeData:))]
    fn download_did_fail(&self, download: &WKDownload, error: &NSError, resume_data: &NSData) {
      download_did_fail(self, download, error, resume_data);
    }
  }
);

impl WryDownloadDelegate {
  pub fn new(
    download_started_handler: Option<Box<dyn FnMut(String, &mut PathBuf) -> bool + 'static>>,
    download_completed_handler: Option<Rc<dyn Fn(String, Option<PathBuf>, bool) + 'static>>,
    mtm: MainThreadMarker,
  ) -> Retained<Self> {
    let delegate = mtm
      .alloc::<WryDownloadDelegate>()
      .set_ivars(WryDownloadDelegateIvars {
        started: download_started_handler.map(|handler| RefCell::new(handler)),
        completed: download_completed_handler,
        #[cfg(target_os = "macos")]
        accepted_downloads: RefCell::default(),
        #[cfg(target_os = "macos")]
        cancel_pending_downloads: RefCell::default(),
      });

    unsafe { msg_send![super(delegate), init] }
  }

  #[cfg(target_os = "macos")]
  pub(crate) fn track_accepted_download(
    &self,
    download: &WKDownload,
    url: String,
    destination: PathBuf,
  ) {
    let identity = download as *const WKDownload;
    let mut accepted_downloads = self.ivars().accepted_downloads.borrow_mut();
    if accepted_downloads
      .iter()
      .all(|accepted| Retained::as_ptr(&accepted.download) != identity.cast_mut())
    {
      accepted_downloads.push(AcceptedDownload {
        download: download.retain(),
        url,
        destination,
      });
    }
  }

  #[cfg(target_os = "macos")]
  pub(crate) fn terminal_download(&self, download: &WKDownload) -> TerminalDownload {
    let identity = download as *const WKDownload;
    let accepted = {
      let mut accepted_downloads = self.ivars().accepted_downloads.borrow_mut();
      accepted_downloads
        .iter()
        .position(|accepted| Retained::as_ptr(&accepted.download) == identity.cast_mut())
        .map(|index| accepted_downloads.swap_remove(index))
    };
    if let Some(accepted) = accepted {
      // WebKit's terminal delegate methods are one-shot, but clearing the
      // delegate makes that property explicit without retaining a tombstone
      // for the whole lifetime of a long-lived web view.
      unsafe { download.setDelegate(None) };
      return TerminalDownload::Accepted(accepted.url, accepted.destination);
    }

    let cancellation_pending = {
      let mut cancellation_pending = self.ivars().cancel_pending_downloads.borrow_mut();
      cancellation_pending
        .iter()
        .position(|pending| Retained::as_ptr(&pending.download) == identity.cast_mut())
        .map(|index| cancellation_pending.swap_remove(index))
    };
    if let Some(cancellation_pending) = cancellation_pending {
      // This terminal delegate callback won the race with the cancellation
      // completion, so prevent a later duplicate callback directly.
      unsafe { download.setDelegate(None) };
      return TerminalDownload::CancelPending(
        cancellation_pending.url,
        cancellation_pending.destination,
      );
    }

    TerminalDownload::Untracked
  }

  #[cfg(target_os = "macos")]
  pub(crate) fn acknowledge_download_cancellation(
    &self,
    identity: *const WKDownload,
  ) -> Option<(String, PathBuf)> {
    let cancellation_pending = {
      let mut cancellation_pending = self.ivars().cancel_pending_downloads.borrow_mut();
      cancellation_pending
        .iter()
        .position(|pending| Retained::as_ptr(&pending.download) == identity.cast_mut())
        .map(|index| cancellation_pending.swap_remove(index))
    };
    cancellation_pending.map(|pending| {
      // The cancellation completion won. Clear this exact controller's weak
      // delegate before releasing the retained pending record, so a later
      // terminal delegate callback cannot duplicate it and an Objective-C
      // address reused by another download is never suppressed.
      unsafe { pending.download.setDelegate(None) };
      (pending.url, pending.destination)
    })
  }

  #[cfg(target_os = "macos")]
  pub(crate) fn cancel_accepted_downloads(&self) {
    // Transition before calling Cocoa: cancel may synchronously invoke one of
    // the delegate callbacks. Do not hold any RefCell borrow across that call.
    let accepted = std::mem::take(&mut *self.ivars().accepted_downloads.borrow_mut());
    {
      let mut cancellation_pending = self.ivars().cancel_pending_downloads.borrow_mut();
      cancellation_pending.extend(accepted.iter().map(|accepted| CancelPendingDownload {
        download: accepted.download.clone(),
        url: accepted.url.clone(),
        destination: accepted.destination.clone(),
      }));
    }

    for accepted in accepted {
      let identity = Retained::as_ptr(&accepted.download);
      let delegate = self.retain();
      // This temporary cycle (delegate -> pending exact controller -> cancel
      // completion -> delegate) is created only while one closing WebView
      // awaits its accepted downloads' terminal acknowledgement. Both exact
      // terminal paths remove the pending controller; no callback leaves the
      // native work and ShellX cleanup-pending evidence retained rather than
      // pretending cancellation completed. Resume data is never retained.
      let completion = RcBlock::new(move |_resume_data: *mut NSData| {
        download_cancelled(&delegate, identity);
      });
      unsafe { accepted.download.cancel(Some(&completion)) };
    }
  }
}
