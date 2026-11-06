const form = document.getElementById('shorten-form');
const urlInput = document.getElementById('url');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const shortUrlEl = document.getElementById('short-url');
const copyBtn = document.getElementById('copy');
const linksBody = document.querySelector('#links tbody');
const emptyEl = document.getElementById('empty');
const submitBtn = form.querySelector('button[type="submit"]');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
}

async function loadLinks() {
  const res = await fetch('/api/links');
  if (!res.ok) return;
  const links = await res.json();
  linksBody.replaceChildren();
  emptyEl.hidden = links.length > 0;
  for (const link of links) {
    const tr = document.createElement('tr');

    const shortTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = link.short_url;
    a.textContent = link.code;
    a.target = '_blank';
    a.rel = 'noopener';
    shortTd.append(a);

    const destTd = document.createElement('td');
    destTd.className = 'dest';
    destTd.title = link.long_url;
    destTd.textContent = link.long_url;

    const countTd = document.createElement('td');
    countTd.className = 'num';
    countTd.textContent = String(link.used_count);

    tr.append(shortTd, destTd, countTd);
    linksBody.append(tr);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      showError(body.error || 'Something went wrong');
      return;
    }
    shortUrlEl.href = body.short_url;
    shortUrlEl.textContent = body.short_url;
    resultEl.hidden = false;
    copyBtn.textContent = 'Copy';
    urlInput.value = '';
    await loadLinks();
  } catch {
    showError('Could not reach the server');
  } finally {
    submitBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shortUrlEl.href);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  } catch {
    showError('Copy failed; select the link and copy it manually');
  }
});

loadLinks().catch(() => {});
