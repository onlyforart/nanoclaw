/**
 * Scenario format for the pipeline end-to-end test harness.
 * Describes a sequence of synthetic observations (bypassing the
 * sanitiser) and the expected downstream outcomes.
 */

export interface ScenarioMessage {
  /** Milliseconds from scenario start when this message lands. */
  dt_ms: number;
  sender_id: string;
  sender_name?: string;
  text: string;
  /** Pre-computed sanitised classification. Pass-through to the event payload. */
  sanitised: {
    urgency: string;
    speech_act: string;
    addressee: 'channel' | 'nobody' | 'specific_human' | 'bot';
    appears_to_address_bot: boolean;
    contains_imperative: boolean;
    fact_summary?: string;
    reporter_role_hint?: string;
    sentiment?: string;
    action_requested?: string | null;
    resolution_owner_hint?: string;
    referenced_tickets?: string[];
    inc_present?: boolean;
    // Allow arbitrary extra keys — sanitised payload is structurally open.
    [key: string]: unknown;
  };
}

export interface ExpectedCluster {
  /** Expected cluster_key the monitor should choose. */
  key: string;
  /** Expected number of observations in this cluster. */
  observation_count: number;
  /** If set, the cluster must reach this status (e.g. "resolved"). */
  status?: 'active' | 'resolved';
}

export interface ExpectedEvent {
  type:
    | 'candidate.escalation'
    | 'candidate.question'
    | 'candidate.unhandled'
    | 'human_review_required'
    | 'pipeline_event_timeout'
    | 'pipeline_delivery_failed';
  /** Expected number of events of this type tied to the cluster. */
  count: number;
  /** Optional payload assertions applied to each matching event. */
  payload_contains?: Record<string, unknown>;
}

export interface ExpectedOutcome {
  clusters: ExpectedCluster[];
  events: ExpectedEvent[];
  /**
   * Window (ms) the harness waits for outcomes to appear before
   * timing out and reporting failure. Default: 4 min — generous
   * for one solver invocation per candidate event.
   */
  timeout_ms?: number;
}

export interface Scenario {
  name: string;
  description?: string;
  /** Target source channel JID (must already be registered). */
  source_channel: string;
  /** Sanitiser version string attached to synthetic observations. */
  sanitiser_version?: string;
  messages: ScenarioMessage[];
  expected: ExpectedOutcome;
}
