import { memo, useRef } from 'react';
import { SendIcon, StopIcon, UploadIcon } from '../common/icons.jsx';

export const ComposerActions = memo(function ComposerActions({ onUpload, canUpload, disabled, running, queuedCount, modelControl = null }) {
  const fileInputRef = useRef(null);
  const uploadFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length) await onUpload(files);
  };
  const submitLabel = disabled ? '先创建或选择一个项目' : running ? '终止当前执行' : queuedCount ? `发送，${queuedCount} 条消息待执行` : '发送消息';
  // Two groups, not three children: `.composer-actions` is `space-between`, so a bare model
  // button between upload and send would be pushed into the middle of the row.
  return (
    <div className="composer-actions">
      <div className="composer-tools">
        <button
          className="composer-upload-button"
          type="button"
          data-tooltip="上传文件到项目当前目录"
          aria-label="上传文件到项目当前目录"
          disabled={!canUpload}
          onClick={() => fileInputRef.current?.click()}
        >
          <UploadIcon />
        </button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={uploadFiles} />
      </div>
      <div className="composer-submit">
        {modelControl}
        <button className="composer-send-button" type="submit" data-tooltip={submitLabel} aria-label={submitLabel} disabled={disabled}>
          {running ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </div>
  );
});
