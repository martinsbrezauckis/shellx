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
        .map(|candidate| BrowserResolvedEngineTarget {
            selector: candidate
                .raw_selector
                .clone()
                .or_else(|| candidate.selector.clone()),
            expected_fingerprint: candidate.fingerprint.clone(),
            locator: candidate.raw_locator.clone(),
        })
}
