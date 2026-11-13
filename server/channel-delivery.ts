import type {PromptOutbox,PromptIntent,PromptReceipt} from './prompt-outbox';

// Channel notices and peer messages share the durable, per-agent prompt queue.
// Returning queued means persisted intent, never a claim of daemon acceptance.
export function queueChannelPrompt(outbox:PromptOutbox,input:Omit<PromptIntent,'kind'>):PromptReceipt['status'] {
 const receipt=outbox.submit({...input,kind:'channel'});
 void outbox.drain();
 return receipt.status;
}
