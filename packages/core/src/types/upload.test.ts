import { describe, expect, it } from 'vitest';
import {
  buildUploadAttachmentPrompt,
  classifyPublishedFileDisplayType,
  isToolImageContentBlock,
  parseUploadAttachmentPrompt,
  sanitizeUploadFilename,
} from './upload';

const ref = 'upl_00000000-0000-4000-8000-000000000001';

describe('upload attachment prompt', () => {
  it('round-trips the executor block without exposing it as visible text', () => {
    const prompt = buildUploadAttachmentPrompt('解释这张图', [
      { ref, filename: 'chart.png', mimeType: 'image/png', size: 2048 },
    ]);
    expect(parseUploadAttachmentPrompt(prompt)).toEqual({
      attachments: [{ ref, filename: 'chart.png', mimeType: 'image/png', sizeLabel: '2.0 KiB' }],
      visibleText: '解释这张图',
    });
  });

  it('preserves malformed blocks verbatim', () => {
    const content = 'Attached files:\nnot an upload\n\nhello';
    expect(parseUploadAttachmentPrompt(content)).toEqual({ attachments: [], visibleText: content });
  });
});

describe('published file display classification', () => {
  it.each([
    ['image/png', 'image'],
    ['application/pdf', 'pdf'],
    ['audio/mpeg', 'audio'],
    ['video/mp4', 'video'],
    ['application/zip', 'file'],
  ] as const)('maps %s to %s', (mimeType, expected) => {
    expect(classifyPublishedFileDisplayType(mimeType)).toBe(expected);
  });
});

describe('tool image content blocks', () => {
  it('accepts authenticated previews and bounded unavailable placeholders', () => {
    expect(
      isToolImageContentBlock({
        type: 'image',
        upload_ref: ref,
        filename: 'chart.png',
        mime_type: 'image/png',
        size: 2048,
        available: true,
      })
    ).toBe(true);
    expect(
      isToolImageContentBlock({
        type: 'image',
        filename: 'chart.png',
        mime_type: 'image/png',
        available: false,
        unavailable_reason: '图片预览暂不可用',
      })
    ).toBe(true);
    expect(
      isToolImageContentBlock({
        type: 'image',
        filename: 'chart.png',
        mime_type: 'image/png',
        available: true,
      })
    ).toBe(false);
  });
});

describe('upload filename sanitization', () => {
  it('preserves normalized Chinese names while removing path traversal and forbidden characters', () => {
    expect(sanitizeUploadFilename(String.raw`..\外壳:预览.SLDPRT`)).toBe('外壳_预览.SLDPRT');
    expect(sanitizeUploadFilename('../资料/测试图.png')).toBe('测试图.png');
  });
});
