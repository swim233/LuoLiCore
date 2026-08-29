import type { Role } from "@luoli/shared";
import { maxRole, minRole } from "@luoli/shared";

/**
 * 有效角色的全库唯一判据（docs/05 §2.2）。
 *
 * 私聊只看用户角色 —— 私聊不再登记 `chat:` 主体行，「会话角色」在那一侧没有可信来源。
 *
 * 群 / 频道里会话角色从**上限**翻成**下限**：取两侧较高者，让未单独登记的成员借群的授信参与，
 * 而不是被自己那一行拖回默认档。封顶 `trusted` 保住的是「防群内注入借权」那道闸 ——
 * 群里的发言是任何人都能写的文本，owner 档的工具不该由它够得着。
 *
 * 由此得到两条不变量：`effectiveRole === 'owner'` ⟹ `isPrivate`；群里的有效角色只可能是
 * `blocked` / `limited` / `trusted`。
 *
 * `blocked` 任一侧一票否决（先于取较高者判定），因此 `access.defaultChatRole`（出厂 `blocked`）
 * 仍然表示「未登记的群整群静默」，抬升语义没有把它变成一扇默认敞开的门。
 */
export function resolveEffectiveRole(input: {
  userRole: Role;
  chatRole?: Role;
  isPrivate: boolean;
  defaultChatRole: Role;
}): Role {
  if (input.isPrivate) return input.userRole;
  const chatRole = input.chatRole ?? input.defaultChatRole;
  if (input.userRole === "blocked" || chatRole === "blocked") return "blocked";
  return minRole(maxRole(input.userRole, chatRole), "trusted");
}
