import type { Role } from '@luoli/shared';
import { minRole } from '@luoli/shared';

export function resolveEffectiveRole(input: {
  userRole: Role;
  chatRole?: Role;
  isPrivate: boolean;
  defaultChatRole: Role;
}): Role {
  const chatRole = input.chatRole ?? (input.isPrivate ? input.userRole : input.defaultChatRole);
  return minRole(input.userRole, chatRole);
}
