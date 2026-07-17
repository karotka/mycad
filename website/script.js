const header = document.querySelector('.site-header');
const menuButton = document.querySelector('.menu-button');

menuButton?.addEventListener('click', () => {
  const open = header.classList.toggle('menu-open');
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Zavřít menu' : 'Otevřít menu');
});

header?.querySelectorAll('nav a').forEach((link) => link.addEventListener('click', () => {
  header.classList.remove('menu-open');
  menuButton?.setAttribute('aria-expanded', 'false');
}));

const form = document.querySelector('.notify-form');
const message = document.querySelector('.form-message');
form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const email = form.querySelector('input');
  if (!email.checkValidity()) {
    message.textContent = 'Zadejte prosím platnou e-mailovou adresu.';
    email.focus();
    return;
  }
  message.textContent = 'Děkujeme. Jakmile bude MyCAD připravený, ozveme se.';
  form.reset();
});

document.querySelector('#year').textContent = new Date().getFullYear();
