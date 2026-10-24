for (const button of document.querySelectorAll('[data-copy-task]')) {
  button.addEventListener('click', async () => {
    const text = document.querySelector(button.dataset.copyTarget || '#agent-task')?.textContent;
    const status = button.nextElementSibling;
    const de = document.documentElement.lang === 'de';
    if (!text || !status) return;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = de ? 'Kopiert.' : 'Copied.';
    } catch {
      status.textContent = de ? 'Bitte den Text unten markieren und kopieren.' : 'Please select and copy the text below.';
    }
  });
}
