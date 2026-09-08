import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AutocompleteTextarea } from './AutocompleteTextarea';

const renderSlashAutocomplete = () => {
  const Harness = () => {
    const [value, setValue] = useState('');

    return (
      <AutocompleteTextarea
        value={value}
        onChange={setValue}
        placeholder="Prompt"
        client={null}
        sessionId={null}
        userById={new Map()}
        slashCommands={['alpha', 'beta']}
      />
    );
  };

  render(<Harness />);
  return screen.getByPlaceholderText('Prompt') as HTMLTextAreaElement;
};

const renderFilePasteTextarea = (
  onFilesDrop = vi.fn(),
  options: { filesDropDisabled?: boolean; showFilesDropOverlay?: boolean } = {}
) => {
  const Harness = () => {
    const [value, setValue] = useState('');

    return (
      <AutocompleteTextarea
        value={value}
        onChange={setValue}
        placeholder="Prompt"
        client={null}
        sessionId={null}
        userById={new Map()}
        onFilesDrop={onFilesDrop}
        filesDropDisabled={options.filesDropDisabled}
        showFilesDropOverlay={options.showFilesDropOverlay}
        suppressEmptyHighlight={false}
      />
    );
  };

  render(<Harness />);
  return {
    textarea: screen.getByPlaceholderText('Prompt') as HTMLTextAreaElement,
    onFilesDrop,
  };
};

const clipboardFileItem = (file: File, type = file.type): DataTransferItem =>
  ({
    kind: 'file',
    type,
    getAsFile: () => file,
  }) as DataTransferItem;

const waitForStateUpdate = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AutocompleteTextarea', () => {
  it('does not forward Enter while an IME composition is being confirmed', () => {
    const onKeyPress = vi.fn();
    render(
      <AutocompleteTextarea
        value="正在输入"
        onChange={vi.fn()}
        onKeyPress={onKeyPress}
        placeholder="Prompt"
        client={null}
        sessionId={null}
        userById={new Map()}
      />
    );
    const textarea = screen.getByPlaceholderText('Prompt');

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onKeyPress).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 229 });
    expect(onKeyPress).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onKeyPress).toHaveBeenCalledTimes(1);
  });

  it('selects the default highlighted autocomplete item with Enter', async () => {
    const textarea = renderSlashAutocomplete();

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('alpha');
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('/alpha ');
    });
  });

  it('navigates autocomplete options upward with arrow keys', async () => {
    const textarea = renderSlashAutocomplete();

    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });

    await screen.findByText('alpha');
    expect(screen.getByText('beta')).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    await waitForStateUpdate();
    fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    await waitForStateUpdate();
    fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, which: 38 });
    await waitForStateUpdate();
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(textarea).toHaveValue('/alpha ');
    });
  });

  it('routes pasted image files through file drop handling with screenshot names', () => {
    const { textarea, onFilesDrop } = renderFilePasteTextarea();
    const imageFile = new File(['image'], 'clipboard.png', { type: 'image/png' });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [clipboardFileItem(imageFile)],
      },
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(onFilesDrop).toHaveBeenCalledTimes(1);
    const [files] = onFilesDrop.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^pasted-screenshot-.*\.png$/);
    expect(files[0].type).toBe('image/png');
  });

  it('routes pasted non-image files through file drop handling', () => {
    const { textarea, onFilesDrop } = renderFilePasteTextarea();
    const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [clipboardFileItem(textFile)],
      },
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(onFilesDrop).toHaveBeenCalledWith([textFile]);
  });

  it('blocks pasted and dropped files when file handling is disabled', () => {
    const { textarea, onFilesDrop } = renderFilePasteTextarea(vi.fn(), {
      filesDropDisabled: true,
    });
    const imageFile = new File(['image'], 'clipboard.png', { type: 'image/png' });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [clipboardFileItem(imageFile)],
      },
    });
    const dropEvent = createEvent.drop(textarea, {
      dataTransfer: {
        files: [imageFile],
      },
    });

    fireEvent(textarea, pasteEvent);
    fireEvent(textarea, dropEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(onFilesDrop).not.toHaveBeenCalled();
  });

  it('can route dropped files without showing the textarea-local drop overlay', () => {
    const { textarea, onFilesDrop } = renderFilePasteTextarea(vi.fn(), {
      showFilesDropOverlay: false,
    });
    const imageFile = new File(['image'], 'chart.png', { type: 'image/png' });

    fireEvent.dragOver(textarea, {
      dataTransfer: {
        files: [imageFile],
      },
    });

    expect(screen.queryByText('Drop files here to upload')).not.toBeInTheDocument();

    fireEvent.drop(textarea, {
      dataTransfer: {
        files: [imageFile],
      },
    });

    expect(onFilesDrop).toHaveBeenCalledWith([imageFile]);
  });
});
