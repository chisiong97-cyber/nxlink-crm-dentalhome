export interface Env {
  ASSETS: Fetcher;
  NXLINK_TENANT_ID?: string;
  NXLINK_FLOW_NAME?: string;
  NXLINK_ACCOUNT?: string;
  NXLINK_PASSWORD?: string;
  NXLINK_TOKEN?: KVNamespace;
  DB?: D1Database;
  LARK_CREATED_WEBHOOK_URL?: string;
  LARK_UPDATED_WEBHOOK_URL?: string;
  ABANDON_AFTER_MINUTES?: string;
  VERDICT_WAIT_MINUTES?: string;
  WATCH_HOURS?: string;
  WATCH_RECHECK_MINUTES?: string;
  RETENTION_DAYS?: string;
  SYNC_START_AT?: string;
  LARK_UPDATE_DELAY_SECONDS?: string;
  DRY_RUN?: string;
}
