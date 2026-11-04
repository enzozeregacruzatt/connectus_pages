'use strict';

(() => {
  const results = document.getElementById('results');
  const rows = new Map();

  // Todo con textContent: la query y el fragmento de esta página los escribe quien la abre.
  function show(name, value) {
    let cell = rows.get(name);
    if (!cell) {
      const row = results.insertRow();
      row.insertCell().textContent = name;
      cell = row.insertCell();
      rows.set(name, cell);
    }
    cell.textContent = value;
  }

  function attempt(name, read) {
    try {
      show(name, String(read()));
    } catch (error) {
      show(name, `lanzó ${error.name}`);
    }
  }

  function storageWorks(area) {
    const key = 'sonda';
    area.setItem(key, '1');
    area.removeItem(key);
    return 'funciona';
  }

  async function tryFetch(name, url, options) {
    show(name, 'probando');
    try {
      const response = await fetch(url, options);
      show(name, `${response.status}, ${await response.text()}`);
    } catch (error) {
      show(name, `lanzó ${error.name}`);
    }
  }

  function readEnvironment() {
    attempt('self.origin', () => self.origin);
    attempt('self === top', () => self === top);
    attempt('location.ancestorOrigins', () => (
      location.ancestorOrigins ? JSON.stringify(Array.from(location.ancestorOrigins)) : 'no disponible'
    ));
    attempt('navigator.userAgent', () => navigator.userAgent);
    attempt('isSecureContext', () => isSecureContext);
    attempt('document.referrer', () => document.referrer || 'vacío');
    attempt('document.cookie', () => (document.cookie, 'se puede leer'));
    attempt('localStorage', () => storageWorks(localStorage));
    attempt('sessionStorage', () => storageWorks(sessionStorage));
    attempt('location.search', () => location.search || 'vacío');
    attempt('location.hash', () => location.hash || 'vacío');
  }

  function checkFetch() {
    tryFetch('fetch sin CORS', 'eco-sin-cors');
    tryFetch('fetch con CORS null', 'eco');
    tryFetch('fetch con Authorization', 'eco', { headers: { Authorization: 'Bearer sonda' } });
  }

  function watchReload() {
    show('Hora de carga', new Date().toISOString());
    let seconds = 0;
    show('Segundos en memoria', seconds);
    setInterval(() => {
      seconds += 1;
      show('Segundos en memoria', seconds);
    }, 1000);
  }

  function watchKeyboard() {
    for (const [id, name] of [['first-field', 'Primer campo'], ['second-field', 'Segundo campo']]) {
      const field = document.getElementById(id);
      field.addEventListener('focus', () => show(`${name}, foco`, 'recibió el foco'));
      field.addEventListener('keydown', (event) => show(`${name}, última tecla`, event.key));
      field.addEventListener('input', () => show(`${name}, eco`, field.value));
      field.addEventListener('paste', () => show(`${name}, pegar`, 'llegó el evento'));
    }
  }

  function watchForm() {
    const counts = { click: 0, keydown: 0, submit: 0 };
    const count = (kind) => {
      counts[kind] += 1;
      show(`Formulario, ${kind}`, counts[kind]);
    };
    document.getElementById('form-submit').addEventListener('click', () => count('click'));
    document.getElementById('form-field').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') count('keydown');
    });
    document.getElementById('probe-form').addEventListener('submit', (event) => {
      event.preventDefault();
      count('submit');
    });
    for (const kind of Object.keys(counts)) show(`Formulario, ${kind}`, 0);
  }

  function watchWindows() {
    document.getElementById('open-window').addEventListener('click', () => {
      attempt('window.open', () => (window.open('./', '_blank') ? 'devolvió una ventana' : 'devolvió null'));
    });
  }

  function watchBlobDownload() {
    document.getElementById('blob-download').addEventListener('click', () => {
      attempt('Descarga generada', () => {
        const url = URL.createObjectURL(new Blob(['Archivo de prueba de la sonda.\n'], { type: 'text/plain' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'sonda-b.txt';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return 'intentada';
      });
    });
  }

  document.getElementById('not-loaded').hidden = true;
  readEnvironment();
  watchReload();
  checkFetch();
  watchKeyboard();
  watchForm();
  watchWindows();
  watchBlobDownload();
})();
