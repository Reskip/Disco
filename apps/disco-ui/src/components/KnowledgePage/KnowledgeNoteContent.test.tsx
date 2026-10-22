import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KnowledgeNoteContent } from './KnowledgeNoteContent';

describe('knowledge note reading', () => {
  it('renders structured notes without requesting media or executing imported HTML', () => {
    const { container } = render(
      <KnowledgeNoteContent
        markdown={
          '# 结论\n\n- **可迁移**\n- 保留来源\n\n![架构图](https://example.com/diagram.png)\n\n<video src="https://example.com/movie.mp4" autoplay></video>\n<script>alert(1)</script>\n\n[来源](/knowledge?entry=source-a)\n\n[无效](javascript:alert(1))'
        }
      />
    );
    expect(screen.getByRole('heading', { name: '结论' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看图片：架构图' })).toHaveAttribute(
      'href',
      'https://example.com/diagram.png'
    );
    expect(screen.getByRole('link', { name: '来源' })).toHaveAttribute(
      'href',
      '/knowledge?entry=source-a'
    );
    expect(container.querySelector('img,video,audio,iframe,script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
