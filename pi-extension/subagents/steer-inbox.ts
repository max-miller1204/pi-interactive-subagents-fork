/**
 * File inbox for messages that the parent sends to a running subagent.
 *
 * The parent opens `${sessionFile}.steer/` before it launches the child.
 * `queueSteerMessage` moves each message into the inbox with one atomic rename.
 * The child reads the inbox and removes each message that it submits to Pi.
 *
 * Before the child exits, it closes the inbox with one atomic directory rename.
 * After that, a queue attempt fails with `SteerInboxClosedError`.
 * A message is therefore read by the child, reported by the parent as
 * undelivered, or rejected when the parent sends it. It is never lost.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export class SteerInboxClosedError extends Error {
  constructor(sessionFile: string) {
    super(`The steer inbox for ${sessionFile} is closed.`);
    this.name = "SteerInboxClosedError";
  }
}

export function steerInboxPath(sessionFile: string): string {
  return `${sessionFile}.steer`;
}

function closedInboxPath(sessionFile: string): string {
  return `${sessionFile}.steer-closed`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/** Read and remove all messages in a directory, oldest first. */
function takeMessages(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".txt"))
    .sort()
    .map((file) => {
      const path = `${dir}/${file}`;
      const message = readFileSync(path, "utf8");
      unlinkSync(path);
      return message;
    });
}

/**
 * Parent: open an empty inbox before the child launches.
 * An existing inbox belongs to a run that was never cleaned up. Fail instead
 * of silently mixing its messages into the new run.
 */
export function openSteerInbox(sessionFile: string): void {
  const inbox = steerInboxPath(sessionFile);
  if (existsSync(inbox)) {
    throw new Error(
      `Steer inbox ${inbox} already exists. A previous run did not clean it up. ` +
        `Read any messages in it, then remove the directory.`,
    );
  }
  rmSync(closedInboxPath(sessionFile), { recursive: true, force: true });
  mkdirSync(inbox);
}

let queueSequence = 0;

/**
 * Parent: queue a message for the running child.
 * Throws `SteerInboxClosedError` when the child already closed its inbox.
 */
export function queueSteerMessage(sessionFile: string, message: string): void {
  const inbox = steerInboxPath(sessionFile);
  queueSequence += 1;
  const file = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${String(queueSequence).padStart(6, "0")}.txt`;
  // Write outside the inbox so the child never reads a partial message.
  const temporary = `${sessionFile}.steer-${file}.tmp`;
  writeFileSync(temporary, message, "utf8");
  try {
    renameSync(temporary, `${inbox}/${file}`);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (isErrorCode(error, "ENOENT")) throw new SteerInboxClosedError(sessionFile);
    throw error;
  }
}

/** Child: read and remove the queued messages. */
export function takeSteerMessages(sessionFile: string): string[] {
  const inbox = steerInboxPath(sessionFile);
  try {
    return takeMessages(inbox);
  } catch (error) {
    // The child closed the inbox. No message can arrive after that.
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

/**
 * Child: close the inbox before exit.
 * Returns the messages that arrived before the close. When there are any, the
 * inbox opens again, and the child must process them instead of exiting.
 */
export function closeSteerInbox(sessionFile: string): string[] {
  const inbox = steerInboxPath(sessionFile);
  const closed = closedInboxPath(sessionFile);
  renameSync(inbox, closed);
  const messages = takeMessages(closed);
  if (messages.length > 0) renameSync(closed, inbox);
  return messages;
}

/**
 * Parent: remove the inbox after the child exits.
 * Returns the messages that the child never read.
 */
export function removeSteerInbox(sessionFile: string): string[] {
  const inbox = steerInboxPath(sessionFile);
  const undelivered = existsSync(inbox) ? takeMessages(inbox) : [];
  rmSync(inbox, { recursive: true, force: true });
  rmSync(closedInboxPath(sessionFile), { recursive: true, force: true });
  return undelivered;
}
