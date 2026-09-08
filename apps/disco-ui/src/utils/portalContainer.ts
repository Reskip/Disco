/** Keep Ant Design overlays inside the app's display-scale coordinate space. */
export function getDiscoPortalContainer(): HTMLElement {
  return document.getElementById('root') ?? document.body;
}
