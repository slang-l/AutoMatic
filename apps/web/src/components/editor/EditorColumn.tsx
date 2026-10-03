import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocsStore } from '../../store/docsStore';
import type { AppDoc, NormalizedBlock } from '../../types/document';
import { Toast, type ToastState } from '../common/Toast';
import type { BrandAsset } from '../../services/brand-assets-api';
import {
  BlockSuiteEditor,
  type BlockSuiteEditorHandle,
  type EditorToolbarState,
} from './BlockSuiteEditor';
import { BrandAssetLibrary } from './BrandAssetLibrary';
import { EditorToolbar } from './EditorToolbar';
import { ContentComponentLibrary } from './ContentComponentLibrary';
import {
  createContentComponentBlocks,
  type ContentComponentDefinition,
} from './content-components';

interface EditorColumnProps {
  brandAssetLibraryOpen: boolean;
  componentLibraryOpen: boolean;
  doc: AppDoc;
  onBrandAssetLibraryOpenChange: (open: boolean) => void;
  onComponentLibraryOpenChange: (open: boolean) => void;
}

export function EditorColumn({
  brandAssetLibraryOpen,
  componentLibraryOpen,
  doc,
  onBrandAssetLibraryOpenChange,
  onComponentLibraryOpenChange,
}: EditorColumnProps) {
  const renameDoc = useDocsStore((state) => state.renameDoc);
  const updateDocBlocks = useDocsStore((state) => state.updateDocBlocks);
  const editorRef = useRef<BlockSuiteEditorHandle>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [toolbarState, setToolbarState] = useState<EditorToolbarState>({});

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleBlocksChange = useCallback(
    (blocks: NormalizedBlock[]) => {
      updateDocBlocks(doc.id, blocks);
    },
    [doc.id, updateDocBlocks],
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      renameDoc(doc.id, title);
    },
    [doc.id, renameDoc],
  );

  const handleInsertComponent = useCallback((component: ContentComponentDefinition) => {
    const inserted =
      editorRef.current?.insertBlocks(createContentComponentBlocks(component)) ?? false;
    setToast(
      inserted
        ? { message: `已插入「${component.name}」`, tone: 'success' }
        : { message: '组件插入失败，请稍后重试', tone: 'error' },
    );
    return inserted;
  }, []);

  const handleInsertBrandAsset = useCallback((asset: BrandAsset) => {
    const inserted =
      editorRef.current?.insertBlocks([
        {
          id: crypto.randomUUID(),
          type: 'image',
          url: asset.dataUrl,
          alt: asset.name,
          caption: asset.name,
        },
      ]) ?? false;
    setToast(
      inserted
        ? { message: `已插入「${asset.name}」`, tone: 'success' }
        : { message: '素材插入失败，请稍后重试', tone: 'error' },
    );
    return inserted;
  }, []);

  return (
    <section className="editor-column" aria-label="文档编辑区">
      <Toast toast={toast} />
      <EditorToolbar
        state={toolbarState}
        onAction={(action) => editorRef.current?.runAction(action)}
        onOpenAssets={() => onBrandAssetLibraryOpenChange(true)}
        onOpenComponents={() => onComponentLibraryOpenChange(true)}
      />
      <BlockSuiteEditor
        ref={editorRef}
        author={doc.author}
        blocks={doc.blocks}
        docId={doc.id}
        title={doc.title}
        updatedAt={doc.updatedAt}
        onBlocksChange={handleBlocksChange}
        onTitleChange={handleTitleChange}
        onToolbarStateChange={setToolbarState}
      />
      <ContentComponentLibrary
        open={componentLibraryOpen}
        onInsert={handleInsertComponent}
        onOpenChange={onComponentLibraryOpenChange}
      />
      <BrandAssetLibrary
        open={brandAssetLibraryOpen}
        onInsert={handleInsertBrandAsset}
        onOpenChange={onBrandAssetLibraryOpenChange}
      />
    </section>
  );
}
