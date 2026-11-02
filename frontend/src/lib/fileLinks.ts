/**
 * Opens an application file (CV, university letter) through the temporary link the API issues after checking the
 * user may read it. The tab is opened during the click (so it is not blocked as a pop-up) and pointed at the link once
 * it arrives; if the link cannot be obtained, the tab is closed and the error is passed on.
 */
export async function openFileLink(getLink: () => Promise<{ url: string }>): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const { url } = await getLink();
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}
