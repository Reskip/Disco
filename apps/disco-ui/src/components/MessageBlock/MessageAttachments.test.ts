import { describe, expect, it } from 'vitest';
import { parseMessageAttachments } from './MessageAttachments';

const ref = 'upl_00000000-0000-4000-8000-000000000001';

describe('parseMessageAttachments', () => {
  it('removes a leading executor preamble and keeps the user prompt', () => {
    const parsed = parseMessageAttachments(
      `Attached files:\n- [chart.png](https://disco.live/_uploads/${ref}) (image/png, 5.2 KiB)\n\n解释这张图`
    );

    expect(parsed.visibleText).toBe('解释这张图');
    expect(parsed.attachments).toEqual([
      {
        filename: 'chart.png',
        uploadRef: ref,
        mimeType: 'image/png',
        sizeLabel: '5.2 KiB',
      },
    ]);
  });

  it('removes a trailing attachment block after a slash command', () => {
    const parsed = parseMessageAttachments(
      `/review 这个文件\n\nAttached files:\n- [part.SLDPRT](https://disco.live/_uploads/${ref}) (application/octet-stream, 2.8 MB)`
    );

    expect(parsed.visibleText).toBe('/review 这个文件');
    expect(parsed.attachments).toHaveLength(1);
  });

  it('preserves malformed headings instead of dropping content', () => {
    const content = 'Attached files:\nnot an upload\n\nhello';
    expect(parseMessageAttachments(content)).toEqual({ attachments: [], visibleText: content });
  });
});
