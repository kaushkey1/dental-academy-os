import { z } from 'zod';
import {
  plainToRich,
  richTextPlain,
  validateRichText,
  type RichNode,
} from '../shared/rich-text.ts';
import { richTextHtml } from '../shared/rich-text-html.ts';

export const catalogDetailsInput = z
  .unknown()
  .transform((value, ctx) => {
    if (value == null) return value as null | undefined;
    try {
      const doc = validateRichText(value);
      if (!richTextPlain(doc).trim()) return null;
      return doc;
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: (error as Error).message.replaceAll('lesson', 'catalog details'),
      });
      return z.NEVER;
    }
  })
  .optional();

export function catalogDetails(own: RichNode | null, program: RichNode | null, summary: string) {
  const document = validateRichText(own || program || plainToRich(summary));
  return {
    format: 'rich-text-v1',
    source: own ? 'custom' : program ? 'program' : 'description',
    document,
    text: richTextPlain(document),
    html: richTextHtml(document),
  };
}
