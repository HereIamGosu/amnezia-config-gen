const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

describe('donate button', () => {
  test('uses CloudTips link instead of the legacy embedded payment iframe', () => {
    const html = readProjectFile('public/index.html');

    expect(html).toContain('https://pay.cloudtips.ru/p/24080824');
    expect(html).toContain('class="donate-link"');
    expect(html).toContain('data-i18n="donate_button"');
    expect(html).toContain('data-i18n-aria-label="donate_aria"');
    expect(html).not.toContain('yoomoney.ru/quickpay/fundraise/button');
    expect(html).not.toContain('class="donate-iframe"');
  });

  test('has localized button text and accessible label', () => {
    const ru = JSON.parse(readProjectFile('public/locales/ru.json'));
    const en = JSON.parse(readProjectFile('public/locales/en.json'));

    expect(ru.donate_button).toBe('Поддержать проект');
    expect(ru.donate_aria).toBe('Поддержать проект через CloudTips');
    expect(ru.donate_text).toBe('Поддержите автора <br/>и выразите благодарность');
    expect(en.donate_button).toBe('Support the project');
    expect(en.donate_aria).toBe('Support the project via CloudTips');
    expect(en.donate_text).toBe('Support the author <br/>and show appreciation');
  });

  test('keeps a 60/40 row layout for button and text', () => {
    const css = readProjectFile('public/static/styles.css');

    expect(css).toContain('flex-wrap: nowrap;');
    expect(css).toContain('flex: 3 1 0;');
    expect(css).toContain('flex: 2 1 0;');
  });
});
