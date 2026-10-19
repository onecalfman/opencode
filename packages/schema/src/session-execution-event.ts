export * as SessionExecutionEvent from "./session-execution-event"

import { Schema } from "effect"
import { Event } from "./event"
import { SessionID } from "./session-id"

// A live drain boundary, not a durable transcript boundary or execution identity.
export const Finished = Event.define({
  type: "session.execution.finished",
  schema: {
    sessionID: SessionID,
    outcome: Schema.Literals(["completed", "failed", "interrupted"]),
  },
})

export const Definitions = Event.inventory(Finished)
