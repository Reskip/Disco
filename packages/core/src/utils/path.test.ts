import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandPath, extractDbFilePath } from './path';

describe('expandPath', () => {
  it('expands ~/ to home directory', () => {
    expect(expandPath('~/foo')).toBe(join(homedir(), 'foo'));
    expect(expandPath('~/.disco/disco.db')).toBe(join(homedir(), '.disco', 'disco.db'));
  });

  it('expands file:~/ to file: + home directory', () => {
    expect(expandPath('file:~/foo')).toBe(`file:${join(homedir(), 'foo')}`);
    expect(expandPath('file:~/.disco/disco.db')).toBe(`file:${join(homedir(), '.disco', 'disco.db')}`);
  });

  it('returns absolute paths unchanged', () => {
    expect(expandPath('/absolute/path')).toBe('/absolute/path');
    expect(expandPath('/home/user/.disco/disco.db')).toBe('/home/user/.disco/disco.db');
  });

  it('returns file: + absolute paths unchanged', () => {
    expect(expandPath('file:/absolute/path')).toBe('file:/absolute/path');
    expect(expandPath('file:/home/user/.disco/disco.db')).toBe('file:/home/user/.disco/disco.db');
  });

  it('returns remote database URLs unchanged', () => {
    expect(expandPath('libsql://turso.io')).toBe('libsql://turso.io');
    expect(expandPath('https://example.com/db')).toBe('https://example.com/db');
  });

  it('does not expand tilde mid-path', () => {
    expect(expandPath('/foo/~/bar')).toBe('/foo/~/bar');
    expect(expandPath('file:/foo/~/bar')).toBe('file:/foo/~/bar');
  });

  it('handles tilde without trailing slash', () => {
    // ~ alone should not expand (ambiguous, not a path)
    expect(expandPath('~')).toBe('~');
  });
});

describe('extractDbFilePath', () => {
  it('extracts and expands file:~/ URLs', () => {
    expect(extractDbFilePath('file:~/.disco/disco.db')).toBe(join(homedir(), '.disco', 'disco.db'));
    expect(extractDbFilePath('file:~/foo/bar.db')).toBe(join(homedir(), 'foo', 'bar.db'));
  });

  it('extracts and expands ~/ paths', () => {
    expect(extractDbFilePath('~/.disco/disco.db')).toBe(join(homedir(), '.disco', 'disco.db'));
  });

  it('extracts file: prefix from absolute paths', () => {
    expect(extractDbFilePath('file:/absolute/path/db.db')).toBe('/absolute/path/db.db');
  });

  it('returns absolute paths unchanged', () => {
    expect(extractDbFilePath('/absolute/path/db.db')).toBe('/absolute/path/db.db');
  });

  it('handles edge case of path with tilde after file: prefix removal', () => {
    // This tests the defensive second expansion
    // In practice, expandPath should handle this, but we verify both layers work
    const result = extractDbFilePath('file:~/.disco/disco.db');
    expect(result).toBe(join(homedir(), '.disco', 'disco.db'));
    expect(result).not.toContain('~');
  });

  it('works with the default database path pattern', () => {
    // Test the actual default from the codebase
    const defaultPath = 'file:~/.disco/disco.db';
    const result = extractDbFilePath(defaultPath);

    expect(result).toBe(join(homedir(), '.disco', 'disco.db'));
    expect(result).toContain('.disco');
    expect(result).not.toContain('~');
    expect(result).not.toContain('file:');
  });
});
