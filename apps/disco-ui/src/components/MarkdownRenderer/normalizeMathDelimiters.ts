const POWERSHELL_LINE_SIGNAL =
  /(?:\bpowershell\b|\b(?:get|set|test|select|where|foreach|write|new|remove|invoke|resolve|out)-[a-z][\w-]*\b|\bforeach\s*\(|\bforEach-object\b|\bwhere-object\b|\bselect-object\b|(?:^|\s)-command\b|\$(?:env:|_|args\b|input\b)|\$[a-z_][\w]*\s*=)/i;

const POWERSHELL_VARIABLE = /(^|[^\\])\$(?=(?:[a-z_?][\w?]*(?::[a-z_][\w]*)?|\{))/gi;

function protectPowerShellVariables(line: string): string {
  if (!POWERSHELL_LINE_SIGNAL.test(line)) return line;
  return line.replace(POWERSHELL_VARIABLE, '$1\\$');
}

/**
 * Normalize the LaTeX delimiters most LLMs emit into remark-math syntax.
 *
 * Streamdown/remark-math handles dollar delimiters, while Codex and ChatGPT
 * commonly answer with `\(...\)` and `\[...\]`. Keep code spans and fenced
 * blocks byte-for-byte intact so examples of LaTeX source are not rendered as
 * equations accidentally.
 */
export function normalizeCommonLatexDelimiters(source: string): string {
  let output = '';
  let cursor = 0;
  let plainTextStart = 0;

  const flushPlainText = (end: number) => {
    output += source.slice(plainTextStart, end).replace(/[^\r\n]+/g, protectPowerShellVariables);
  };

  while (cursor < source.length) {
    const marker = source[cursor];

    if (marker === '`' || marker === '~') {
      let runLength = 1;
      while (source[cursor + runLength] === marker) runLength += 1;
      const isCodeMarker = marker === '`' || runLength >= 3;
      if (isCodeMarker) {
        const delimiter = marker.repeat(runLength);
        const close = source.indexOf(delimiter, cursor + runLength);
        if (close === -1) {
          flushPlainText(cursor);
          output += source.slice(cursor);
          break;
        }
        flushPlainText(cursor);
        output += source.slice(cursor, close + runLength);
        cursor = close + runLength;
        plainTextStart = cursor;
        continue;
      }
    }

    const escapedByPreviousSlash = cursor > 0 && source[cursor - 1] === '\\';
    if (!escapedByPreviousSlash && source.startsWith('\\(', cursor)) {
      const close = source.indexOf('\\)', cursor + 2);
      if (close !== -1) {
        flushPlainText(cursor);
        output += `$$${source.slice(cursor + 2, close)}$$`;
        cursor = close + 2;
        plainTextStart = cursor;
        continue;
      }
    }
    if (!escapedByPreviousSlash && source.startsWith('\\[', cursor)) {
      const close = source.indexOf('\\]', cursor + 2);
      if (close !== -1) {
        flushPlainText(cursor);
        const expression = source.slice(cursor + 2, close).trim();
        output += `\n$$\n${expression}\n$$\n`;
        cursor = close + 2;
        plainTextStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  if (plainTextStart < source.length && cursor >= source.length) {
    flushPlainText(source.length);
  }

  return output;
}
