/** `<script setup>` 中不能包含 ES export，UI 层共用的类型集中放在这里。 */
export type TagSeverity =
  "primary" | "success" | "info" | "warn" | "danger" | "secondary";
export interface GridColumn {
  key: string;
  header: string;
  field?: string;
  width?: string;
}
export interface ChainItem {
  id: string;
  label: string;
  enabled: boolean;
}
/** `GET /api/messages` 与 `GET /api/turns` 挂在消息行上的附件元数据（不含 `local_path`）。 */
export interface Attachment {
  id: string;
  messageId: number;
  kind: string;
  mime: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  downloadState: string;
  downloadError: string | null;
  extractState: string | null;
  hasLocal: number;
}
