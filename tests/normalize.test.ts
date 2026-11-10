import { describe, expect, it } from 'vitest';
import { domainOf, normalizeUrl, unwrapGoogleRedirect } from '../src/core/normalize';

describe('normalizeUrl', () => {
  it.each([
    ['https://WWW.Casino.org/ca/', 'https://casino.org/ca'],
    ['http://www.casino.org/ca', 'https://casino.org/ca'],
    ['https://casino.org/ca/?utm_source=g&utm_medium=cpc&id=5', 'https://casino.org/ca?id=5'],
    ['https://casino.org/?gclid=1&fbclid=2', 'https://casino.org'],
    ['https://casino.org/page#section', 'https://casino.org/page'],
    ['https://casino.org:443/a//', 'https://casino.org/a'],
    ['https://casino.org/Path/Case', 'https://casino.org/Path/Case'],
    ['https://sub.www.example.com/', 'https://sub.www.example.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('одинаковые страницы дают один ключ', () => {
    const a = normalizeUrl('https://www.covers.com/ca/casino/?utm_campaign=x#top');
    const b = normalizeUrl('http://covers.com/ca/casino');
    expect(a).toBe(b);
  });

  it('не-http URL — ошибка', () => {
    expect(() => normalizeUrl('ftp://x.com')).toThrow();
  });

  it('domainOf убирает www', () => {
    expect(domainOf('https://www.TheStar.com/x')).toBe('thestar.com');
  });
});

describe('unwrapGoogleRedirect', () => {
  it('разворачивает /goto?url= и /url?q=', () => {
    expect(unwrapGoogleRedirect('https://www.google.com/goto?url=https://agco.ca/x')).toBe('https://agco.ca/x');
    expect(unwrapGoogleRedirect('https://www.google.ca/url?q=https://agco.ca/y&sa=U')).toBe('https://agco.ca/y');
  });
  it('обычные ссылки не трогает', () => {
    expect(unwrapGoogleRedirect('https://casino.org/ca')).toBe('https://casino.org/ca');
    expect(unwrapGoogleRedirect('https://play.google.com/store/apps/details?id=x')).toBe('https://play.google.com/store/apps/details?id=x');
  });
});
