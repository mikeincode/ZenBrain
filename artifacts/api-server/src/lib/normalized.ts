import { createHash } from "crypto";

export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  contentHash: string;
  timestamp: number | null;
  /** Provider-specific metadata rendered in markdown, e.g. model_slug. */
  metadata?: Record<string, string>;
}

export interface NormalizedConversation {
  externalId: string;
  title: string;
  messages: NormalizedMessage[];
  createdAt: number | null;
  updatedAt: number | null;
}

export function sha256(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}
