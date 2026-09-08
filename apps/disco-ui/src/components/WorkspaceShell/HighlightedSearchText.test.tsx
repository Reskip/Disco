import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HighlightedSearchText } from './HighlightedSearchText';

describe('HighlightedSearchText', () => {
  it('bolds every case-insensitive term without interpreting it as markup or a regular expression', () => {
    const { container } = render(
      <div>
        <HighlightedSearchText text="C++ 旅行与旅行计划" query="旅行 C++" />
      </div>
    );

    expect(screen.getAllByText('旅行', { selector: 'strong' })).toHaveLength(2);
    expect(screen.getByText('C++', { selector: 'strong' })).toBeInTheDocument();
    expect(container.querySelectorAll('strong.disco-search-match')).toHaveLength(3);
  });
});
