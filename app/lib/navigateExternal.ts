// A full-page navigation away from the app. Its own module so tests can replace it.
export function navigateExternal(url: string): void {
  window.location.assign(url);
}
