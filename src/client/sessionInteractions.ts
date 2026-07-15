import type { RuntimeStatus } from "../shared/models";

type SendShortcutInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
};

export function shouldAutoFollowLiveOutput(status: RuntimeStatus): boolean {
  return status === "starting" || status === "running";
}

export function isTaskSendShortcut(event: SendShortcutInput): boolean {
  return event.key === "Enter" && !event.repeat && (event.ctrlKey || event.metaKey);
}
