import { describe, expect, it } from 'vitest';
import { normalizeCommonLatexDelimiters } from './normalizeMathDelimiters';

describe('normalizeCommonLatexDelimiters', () => {
  it('normalizes inline and display delimiters outside code', () => {
    expect(normalizeCommonLatexDelimiters('A \\(x+1\\) B \\[y=2\\]')).toBe(
      'A $$x+1$$ B \n$$\ny=2\n$$\n'
    );
  });

  it('leaves inline and fenced code unchanged', () => {
    const markdown = '`\\(inline\\)`\n\n```tex\n\\[block\\]\n```';
    expect(normalizeCommonLatexDelimiters(markdown)).toBe(markdown);
  });

  it('preserves an incomplete delimiter while streaming', () => {
    expect(normalizeCommonLatexDelimiters('still typing \\(x +')).toBe('still typing \\(x +');
  });

  it('keeps PowerShell variables literal without disabling ordinary inline math', () => {
    const source =
      '只运行一次 PowerShell：$names="CODEX_HOME"; foreach($n in $names){ $value=$env:CODEX_HOME }。\n另有 $z^2$。';

    expect(normalizeCommonLatexDelimiters(source)).toBe(
      '只运行一次 PowerShell：\\$names="CODEX_HOME"; foreach(\\$n in \\$names){ \\$value=\\$env:CODEX_HOME }。\n另有 $z^2$。'
    );
  });

  it('does not rewrite shell-looking examples inside code spans or fences', () => {
    const source = '`$name = "value"`\n\n```powershell\n$value = Get-Item .\n```';
    expect(normalizeCommonLatexDelimiters(source)).toBe(source);
  });
});
