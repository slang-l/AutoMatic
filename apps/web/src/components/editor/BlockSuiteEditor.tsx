import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import '@blocksuite/presets/themes/affine.css';
import { AffineEditorContainer } from '@blocksuite/presets';
import {
  createBlockSuiteDocument,
  getBlockSuiteTitle,
  insertNormalizedBlocks,
  normalizedBlocksFromBlockSuiteDoc,
  observeBlockSuiteTitle,
  syncBlockSuiteTitle,
  type BlockSuiteDocumentBridge,
} from '../../adapters/blocksuite-adapter';
import type { NormalizedBlock } from '../../types/document';

const MAX_PERSISTED_IMAGE_SIZE = 1_500_000;

interface BlockSuiteEditorProps {
  author: string;
  docId: string;
  title: string;
  updatedAt: string;
  blocks: NormalizedBlock[];
  onBlocksChange: (blocks: NormalizedBlock[]) => void;
  onTitleChange: (title: string) => void;
  onToolbarStateChange: (state: EditorToolbarState) => void;
}

export interface BlockSuiteEditorHandle {
  insertBlocks: (blocks: NormalizedBlock[]) => boolean;
  runAction: (action: EditorAction) => void;
}

export type EditorAction =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'text'
  | 'heading'
  | 'quote'
  | 'bulleted'
  | 'numbered'
  | 'todo';
export type EditorToolbarState = Partial<Record<EditorAction, boolean>>;

function readToolbarState(editor: AffineEditorContainer): EditorToolbarState {
  const state: EditorToolbarState = {};
  for (const key of ['bold', 'italic', 'underline', 'strike', 'code', 'link'] as const) {
    // Use the same mixed-selection rules as the native floating format bar.
    const [active] = editor.host.std.command.chain().isTextStyleActive({ key }).run();
    state[key] = active;
  }
  const [, context] = editor.host.std.command
    .chain()
    .getSelectedModels({ types: ['text', 'block'] })
    .run();
  const models = context.selectedModels ?? [];
  for (const key of ['text', 'heading', 'quote', 'bulleted', 'numbered', 'todo'] as const) {
    const flavour = ['bulleted', 'numbered', 'todo'].includes(key)
      ? 'affine:list'
      : 'affine:paragraph';
    state[key] =
      models.length > 0 &&
      models.every(
        (model) =>
          model.flavour === flavour &&
          'type' in model &&
          model.type === (key === 'heading' ? 'h2' : key),
      );
  }
  return state;
}

export const BlockSuiteEditor = forwardRef<BlockSuiteEditorHandle, BlockSuiteEditorProps>(
  function BlockSuiteEditor(
    {
      author,
      docId,
      title,
      updatedAt,
      blocks,
      onBlocksChange,
      onTitleChange,
      onToolbarStateChange,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const bridgeRef = useRef<BlockSuiteDocumentBridge | null>(null);
    const editorRef = useRef<AffineEditorContainer | null>(null);
    const blocksChangeRef = useRef(onBlocksChange);
    const titleChangeRef = useRef(onTitleChange);
    const toolbarChangeRef = useRef(onToolbarStateChange);
    const refreshToolbarRef = useRef(() => {});

    blocksChangeRef.current = onBlocksChange;
    titleChangeRef.current = onTitleChange;
    toolbarChangeRef.current = onToolbarStateChange;

    useImperativeHandle(
      ref,
      () => ({
        runAction(action) {
          const editor = editorRef.current;
          if (!editor) return;
          const chain = editor.host.std.command.chain();
          try {
            switch (action) {
              case 'undo':
                editor.doc.undo();
                return;
              case 'redo':
                editor.doc.redo();
                return;
              case 'bold':
                chain.toggleBold().run();
                return;
              case 'italic':
                chain.toggleItalic().run();
                return;
              case 'underline':
                chain.toggleUnderline().run();
                return;
              case 'strike':
                chain.toggleStrike().run();
                return;
              case 'code':
                chain.toggleCode().run();
                return;
              case 'link':
                chain.toggleLink().run();
                return;
              default:
                const nextAction = readToolbarState(editor)[action] ? 'text' : action;
                chain
                  .updateBlockType({
                    flavour: ['bulleted', 'numbered', 'todo'].includes(nextAction)
                      ? 'affine:list'
                      : 'affine:paragraph',
                    props: { type: nextAction === 'heading' ? 'h2' : nextAction },
                  })
                  .run();
            }
          } finally {
            refreshToolbarRef.current();
          }
        },
        insertBlocks(nextBlocks) {
          const bridge = bridgeRef.current;
          const editor = editorRef.current;
          if (!bridge || !editor || nextBlocks.length === 0) return false;

          const textSelection = editor.host.selection.find('text');
          const blockSelection = editor.host.selection.find('block');
          const anchorBlockId = textSelection?.end.blockId ?? blockSelection?.blockId ?? null;
          const insertedIds = insertNormalizedBlocks(bridge.doc, nextBlocks, anchorBlockId);

          if (insertedIds.length === 0) return false;
          focusInsertedContent(editor, insertedIds);
          return true;
        },
      }),
      [],
    );

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return undefined;

      let disposed = false;
      let blocksRevision = 0;
      let blocksTimer: number | undefined;
      let titleTimer: number | undefined;
      let toolbarFrame = 0;
      let selectionDisposable: { dispose: () => void } | undefined;
      let editorReady = false;
      toolbarChangeRef.current({});
      const syncToolbar = () => {
        if (!editorReady || disposed) return;
        window.cancelAnimationFrame(toolbarFrame);
        toolbarFrame = window.requestAnimationFrame(() => {
          if (disposed) return;
          toolbarChangeRef.current(readToolbarState(editor));
          // Native buttons also need a refresh when the fixed toolbar changes formatting.
          editor.querySelector('affine-format-bar-widget')?.requestUpdate();
        });
      };
      refreshToolbarRef.current = syncToolbar;
      const commitBlocks = blocksChangeRef.current;
      const commitTitle = titleChangeRef.current;

      const bridge = createBlockSuiteDocument(title, blocks);
      bridgeRef.current = bridge;

      // This is the same native container used by the in-repo BlockSuite
      // playground. It owns the title, slash menu and floating format toolbar.
      const editor = new AffineEditorContainer();
      editor.doc = bridge.doc;
      editor.mode = 'page';
      editor.autofocus = false;
      editor.className = 'affine-editor-container';
      editor.setAttribute('aria-label', 'BlockSuite 文档编辑器');
      host.replaceChildren(editor);
      editorRef.current = editor;

      const blockDisposable = bridge.doc.slots.blockUpdated.on(() => {
        syncToolbar();
        window.clearTimeout(blocksTimer);
        const revision = ++blocksRevision;
        blocksTimer = window.setTimeout(() => {
          void normalizedBlocksFromBlockSuiteDoc(bridge.doc).then((nextBlocks) => {
            if (!disposed && revision === blocksRevision) {
              commitBlocks(nextBlocks);
            }
          });
        }, 120);
      });

      const disposeTitleObserver = observeBlockSuiteTitle(bridge.doc, (nextTitle) => {
        window.clearTimeout(titleTimer);
        titleTimer = window.setTimeout(() => {
          if (!disposed) commitTitle(nextTitle);
        }, 120);
      });

      void editor.getUpdateComplete().then(() => {
        if (!disposed) {
          configureEditor(editor);
          updateDocumentMetadata(editor, author, updatedAt);
          editorReady = true;
          selectionDisposable = editor.host.selection.slots.changed.on(syncToolbar);
          document.addEventListener('selectionchange', syncToolbar);
          syncToolbar();
        }
      });

      return () => {
        const shouldFlushBlocks = blocksTimer !== undefined;
        const shouldFlushTitle = titleTimer !== undefined;
        disposed = true;
        refreshToolbarRef.current = () => {};
        window.cancelAnimationFrame(toolbarFrame);
        selectionDisposable?.dispose();
        document.removeEventListener('selectionchange', syncToolbar);
        window.clearTimeout(blocksTimer);
        window.clearTimeout(titleTimer);

        if (shouldFlushBlocks) {
          void normalizedBlocksFromBlockSuiteDoc(bridge.doc).then(commitBlocks);
        }
        if (shouldFlushTitle) {
          commitTitle(getBlockSuiteTitle(bridge.doc));
        }

        blockDisposable.dispose();
        disposeTitleObserver();
        bridgeRef.current = null;
        editorRef.current = null;
        host.replaceChildren();
      };
    }, [docId]);

    useEffect(() => {
      if (!bridgeRef.current) return;
      syncBlockSuiteTitle(bridgeRef.current.doc, title);
    }, [title]);

    useEffect(() => {
      if (!editorRef.current) return;
      updateDocumentMetadata(editorRef.current, author, updatedAt);
    }, [author, updatedAt]);

    return <div ref={hostRef} className="blocksuite-editor-host h-full min-h-0 w-full" />;
  },
);

function focusInsertedContent(editor: AffineEditorContainer, insertedIds: string[]) {
  window.requestAnimationFrame(() => {
    const editableId = insertedIds.find((id) => editor.doc.getBlockById(id)?.text);
    const model = editableId ? editor.doc.getBlockById(editableId) : null;

    if (model?.text) {
      editor.host.selection.set([
        editor.host.selection.create('text', {
          from: {
            blockId: model.id,
            index: model.text.length,
            length: 0,
          },
          to: null,
        }),
      ]);
    }

    const targetId = editableId ?? insertedIds[0];
    editor
      .querySelector<HTMLElement>(`[data-block-id="${targetId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function updateDocumentMetadata(editor: AffineEditorContainer, author: string, updatedAt: string) {
  const viewport = editor.querySelector<HTMLElement>('.affine-page-viewport');
  if (!viewport) return;

  let metadata = viewport.querySelector<HTMLElement>(':scope > .workspace-document-meta');
  if (!metadata) {
    metadata = document.createElement('div');
    metadata.className = 'workspace-document-meta';
    const badge = document.createElement('span');
    badge.className = 'workspace-document-badge';
    badge.textContent = '公众号草稿';
    const details = document.createElement('span');
    details.className = 'workspace-document-details';
    metadata.append(badge, details);
    viewport.prepend(metadata);
  }
  const details = metadata.querySelector<HTMLElement>('.workspace-document-details');
  if (details) details.textContent = `${author || '未署名'} · ${formatWorkspaceDate(updatedAt)}`;
}

function formatWorkspaceDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function configureEditor(editor: AffineEditorContainer) {
  const imageService = editor.host.spec.getService('affine:image');
  imageService.maxFileSize = MAX_PERSISTED_IMAGE_SIZE;

  type SlashMenuItem = { groupName: string } | { name: string } | ((...args: unknown[]) => unknown);
  type SlashMenuWidget = HTMLElement & {
    config: {
      items: SlashMenuItem[];
      [key: string]: unknown;
    };
  };

  const slashMenu = editor.querySelector<SlashMenuWidget>('affine-slash-menu-widget');
  if (!slashMenu) return;

  // Keep BlockSuite's native menu, limited to blocks that the app's Markdown
  // and WeChat persistence adapters can round-trip without data loss.
  const allowedGroups = new Set(['Basic', 'List', 'Style', 'Content & Media', 'Actions']);
  const allowedItems = new Set([
    'Text',
    'Heading 1',
    'Heading 2',
    'Heading 3',
    'Code Block',
    'Quote',
    'Divider',
    'Bulleted List',
    'Numbered List',
    'To-do List',
    'Bold',
    'Italic',
    'Underline',
    'Strikethrough',
    'Image',
    'Move Up',
    'Move Down',
    'Copy',
    'Duplicate',
    'Delete',
  ]);

  slashMenu.config = {
    ...slashMenu.config,
    items: slashMenu.config.items.filter((item) => {
      if (typeof item === 'function') return false;
      if ('groupName' in item) return allowedGroups.has(item.groupName);
      return allowedItems.has(item.name);
    }),
  };
}
