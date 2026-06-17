export type CaptureMode = "off" | "wiki";
export type ProjectMode = "auto_git" | "off" | "manual";
export type SessionStartContext = "off" | "minimal" | "profile";

export interface PluginConfig {
  apiUrl: string;
  autoRecall: boolean;
  autoWikiRecall: boolean;
  captureMode: CaptureMode;
  maxRecallChars: number;
  sessionStartContext: SessionStartContext;
  projectMode: ProjectMode;
  projectSlug?: string;
  debug: boolean;
}

export interface TokenState {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scope?: string;
}

export interface NodeResponse {
  uuid: string;
  name: string;
  labels?: string[];
  summary?: string | null;
  source?: string | null;
  created_at?: string | null;
  valid_at?: string | null;
  attributes?: Record<string, unknown>;
}

export interface EdgeResponse {
  uuid: string;
  name?: string;
  fact?: string | null;
  source_node_uuid?: string;
  target_node_uuid?: string;
  created_at?: string | null;
  valid_at?: string | null;
  invalid_at?: string | null;
  expired_at?: string | null;
}

export interface EpisodeBundle {
  episode: NodeResponse;
  relevance_score?: number | null;
  nodes?: NodeResponse[];
  edges?: EdgeResponse[];
}

export interface WikiDocument {
  id: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  source?: string;
  source_status?: string | null;
  source_warning?: string | null;
  source_last_checked_at?: string | null;
  source_references?: WikiSourceReference[];
  collection_id?: string | null;
  collection_name?: string | null;
  similarity?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  recent_at?: string | null;
  routing?: WikiDocumentRoutingInfo | null;
  merged_into_document_id?: string | null;
  merged_at?: string | null;
  merged_by_proposal_id?: string | null;
}

export interface WikiSourceReference {
  id?: string | null;
  source: string;
  source_category?: string | null;
  import_format?: string | null;
  external_id?: string | null;
  url?: string | null;
  source_path?: string | null;
  title?: string | null;
  status?: string | null;
  warning?: string | null;
  last_seen_at?: string | null;
  last_synced_at?: string | null;
  source_created_at?: string | null;
  source_last_edited_at?: string | null;
  truncated?: boolean;
  link_type: "primary" | "supporting" | "derived" | "updated";
}

export interface WikiDocumentRoutingInfo {
  collection_id?: string | null;
  collection_name?: string | null;
  routing_source?:
    | "collection_id"
    | "explicit_project"
    | "legacy_collection"
    | "auto_route"
    | "fallback_uncategorized";
  reason?: string | null;
  fallback?: boolean;
  confidence?: number | null;
}

export interface CaptureRecord {
  capture_id: string;
  capture_kind: "conversation_transcript" | "explicit" | "project_index";
  content: string;
  title?: string;
  display_summary?: string;
  project?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  attempts?: number;
  sent_part_count?: number;
  last_error?: string;
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_calls?: Array<Record<string, unknown>>;
  last_assistant_message?: string;
  [key: string]: unknown;
}

export class MembaseApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "MembaseApiError";
  }
}
