import type { McpTool } from '../types';
import { READ_ONLY } from './shared';

// From docs/brand.md. Static, so it is the same for everyone and holds no money amounts.
const PRINCIPLES = [
  'Keep it calm: this is a low-stimulation app, so no flashing, no animation and nothing that moves on its own.',
  'Never let colour be the only signal: pair it with a label, an icon, or a plus or minus sign.',
  'Show one or two series at a time; more than that is hard to read.',
  'Label values directly on the picture instead of sending the eye to a separate key.',
  'Put the largest first, so the biggest items are read first.',
  'Leave plenty of space around each element.',
  'Offer more rather than show more: start with the few points that matter, then ask if they want the detail.',
  'Use plain, kind words: "went over", never blame.',
];

const VARIATIONS = [
  'Fewer colours, or a single colour.',
  'Numbers only, with no picture.',
  'One big figure for the thing they care about most.',
  'A picture instead of a table, or a table instead of a picture.',
  'Bigger text.',
];

export const displayGuidanceTool: McpTool = {
  name: 'display_guidance',
  title: 'Display guidance',
  description:
    'Gives the principles for showing budget figures in Hoardwise\'s calm style, and the variations a person can ask for. Takes no input and holds no personal data. Read-only.',
  access: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: READ_ONLY,
  async run() {
    return { ok: true, data: { principles: PRINCIPLES, variations: VARIATIONS } };
  },
};
