/** `<script setup>` 里不能有 ES export，UI 层共用的类型集中放这里。 */
export type TagSeverity = 'primary' | 'success' | 'info' | 'warn' | 'danger' | 'secondary';
export interface GridColumn { key: string; header: string; field?: string; width?: string }
export interface ChainItem { id: string; label: string; enabled: boolean }
