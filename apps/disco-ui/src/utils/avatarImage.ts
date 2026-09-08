const AVATAR_EDGE_PX = 256;
const MAX_AVATAR_FILE_BYTES = 5 * 1024 * 1024;

/** Crop an uploaded image to a compact square data URL for local profile storage. */
export async function cropAvatarImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > MAX_AVATAR_FILE_BYTES) throw new Error('头像图片不能超过 5 MB');

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('无法读取这张图片'));
      element.src = objectUrl;
    });
    const sourceEdge = Math.min(image.naturalWidth, image.naturalHeight);
    if (!sourceEdge) throw new Error('图片尺寸无效');
    const sourceX = Math.max(0, (image.naturalWidth - sourceEdge) / 2);
    const sourceY = Math.max(0, (image.naturalHeight - sourceEdge) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_EDGE_PX;
    canvas.height = AVATAR_EDGE_PX;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理这张图片');
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceEdge,
      sourceEdge,
      0,
      0,
      AVATAR_EDGE_PX,
      AVATAR_EDGE_PX
    );
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
