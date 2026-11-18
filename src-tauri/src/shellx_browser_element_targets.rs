use crate::shellx_browser::{
    clean_string, lock_or_recover, BrowserObservation, ShellxBrowserRegistry,
};
use crate::shellx_browser_tasks::find_task_index;

#[derive(Default)]
pub(crate) struct BrowserResolvedEngineTarget {
    pub(crate) selector: Option<String>,
    pub(crate) expected_fingerprint: Option<String>,
    pub(crate) locator: Option<String>,
}

impl ShellxBrowserRegistry {
    pub fn resolve_engine_selector(
        &self,
        requested_browser_tab_id: Option<String>,
        requested_task_id: Option<String>,
        ref_id: Option<String>,
        selector: Option<String>,
    ) -> Result<Option<String>, String> {
        Ok(self
            .resolve_engine_target(
                requested_browser_tab_id,
                requested_task_id,
                ref_id,
                selector,
            )?
            .selector)
    }

    pub(crate) fn resolve_engine_target(
        &self,
        requested_browser_tab_id: Option<String>,
        requested_task_id: Option<String>,
        ref_id: Option<String>,
        selector: Option<String>,
    ) -> Result<BrowserResolvedEngineTarget, String> {
        if let Some(selector) = selector
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if ref_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                let observed = self.resolve_engine_target(
                    requested_browser_tab_id,
                    requested_task_id,
                    ref_id,
                    None,
                )?;
                if observed.selector.as_deref() != Some(selector) {
                    return Err("Browser selector does not match the observed refId".to_string());
                }
                return Ok(observed);
            }
            let observed = {
                let state = lock_or_recover(&self.state);
                let task_id = requested_task_id
                    .as_deref()
                    .map(clean_string)
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        requested_browser_tab_id.as_deref().and_then(|tab_id| {
                            state
                                .tabs
                                .iter()
                                .find(|tab| tab.browser_tab_id == clean_string(tab_id))
                                .and_then(|tab| tab.task_id.clone())
                        })
                    })
                    .or_else(|| state.active_task_id.clone());
                task_id
                    .as_deref()
                    .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
                    .and_then(|task| task.last_observation.as_ref())
                    .and_then(|observation| target_for_observation_selector(observation, selector))
            };
            if let Some(observed) = observed {
                return Ok(observed);
            }
            return Ok(BrowserResolvedEngineTarget {
                selector: Some(selector.to_string()),
                expected_fingerprint: None,
                locator: None,
            });
        }
        let Some(ref_id) = ref_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(BrowserResolvedEngineTarget::default());
        };
        if matches!(ref_id, "page" | "address" | "report") {
            return Ok(BrowserResolvedEngineTarget::default());
        }
        if ref_id.starts_with('#')
            || ref_id.starts_with('.')
            || ref_id.starts_with('[')
            || ref_id.contains('>')
            || ref_id.contains(':')
        {
            return Ok(BrowserResolvedEngineTarget {
                selector: Some(ref_id.to_string()),
                expected_fingerprint: None,
                locator: None,
            });
        }

        let state = lock_or_recover(&self.state);
        let task_id = requested_task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                requested_browser_tab_id
                    .as_deref()
                    .map(clean_string)
                    .filter(|value| !value.is_empty())
                    .and_then(|tab_id| {
                        state
                            .tabs
                            .iter()
                            .find(|tab| tab.browser_tab_id == tab_id)
                            .and_then(|tab| tab.task_id.clone())
                    })
            })
            .or_else(|| state.active_task_id.clone());
        if let Some(task_id) = task_id {
            let idx = find_task_index(&state, &task_id)?;
            if let Some(target) = state.tasks[idx]
                .last_observation
                .as_ref()
                .and_then(|observation| target_for_observation_ref(observation, ref_id))
            {
                return Ok(target);
            }
        }
        let tab_id = requested_browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        Ok(tab_id
            .as_deref()
            .and_then(|tab_id| state.tab_observations.get(tab_id))
            .and_then(|observation| target_for_observation_ref(observation, ref_id))
            .unwrap_or_default())
    }
}

fn target_for_observation_ref(
    observation: &BrowserObservation,
    ref_id: &str,
) -> Option<BrowserResolvedEngineTarget> {
    observation
        .refs
        .iter()
        .find(|candidate| candidate.ref_id == ref_id)
        .map(target_from_observation_ref)
}

fn target_for_observation_selector(
    observation: &BrowserObservation,
    selector: &str,
) -> Option<BrowserResolvedEngineTarget> {
    let mut matches = observation.refs.iter().filter(|candidate| {
        candidate
            .raw_selector
            .as_deref()
            .or(candidate.selector.as_deref())
            == Some(selector)
    });
    let candidate = matches.next()?;
    (matches.next().is_none()
        && candidate
            .fingerprint
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()))
    .then(|| target_from_observation_ref(candidate))
}

fn target_from_observation_ref(
    candidate: &crate::shellx_browser::BrowserObservationRef,
) -> BrowserResolvedEngineTarget {
    BrowserResolvedEngineTarget {
        selector: candidate
            .raw_selector
            .clone()
            .or_else(|| candidate.selector.clone()),
        expected_fingerprint: candidate.fingerprint.clone(),
        locator: candidate.raw_locator.clone(),
    }
}
