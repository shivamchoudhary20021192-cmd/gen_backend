/**
 * The words of the cookie banner, the preferences dialog and the privacy
 * pages, in the languages the theme kit ships. A merchant can reword the
 * banner per language (shop_privacy_settings.banner_copy); everything else
 * follows the storefront's language, falling back to English.
 *
 * Written to the standard regulators hold banners to: say what is used and
 * why in plain words, make refusing as easy as accepting (same button, same
 * size, same layer), and say how to change your mind later.
 */

export interface PrivacyCopy {
  title: string;
  message: string;
  accept: string;
  decline: string;
  manage: string;
  save: string;
  close: string;
  privacy_policy: string;
  preferences_title: string;
  preferences_intro: string;
  always_on: string;
  essential_title: string;
  essential_description: string;
  preferences_category_title: string;
  preferences_category_description: string;
  analytics_title: string;
  analytics_description: string;
  marketing_title: string;
  marketing_description: string;
  sale_title: string;
  sale_description: string;
  cookie_preferences_link: string;
  privacy_choices_link: string;
  saved: string;
  // The "Your privacy choices" page (US opt-out of sale or sharing).
  choices_title: string;
  choices_intro: string;
  choices_opted_out: string;
  choices_opted_in: string;
  choices_gpc: string;
  choices_opt_out: string;
  choices_opt_in: string;
  choices_request: string;
  // The privacy request form.
  request_title: string;
  request_intro: string;
  request_email: string;
  request_type: string;
  request_details: string;
  request_submit: string;
  request_sent: string;
  request_verified: string;
  request_invalid: string;
  request_account_hint: string;
  request_types: Record<'access' | 'portability' | 'correction' | 'erasure' | 'withdraw_consent' | 'grievance', string>;
}

/** The parts of the banner a merchant may reword. */
export const EDITABLE_BANNER_COPY = ['title', 'message', 'accept', 'decline', 'manage'] as const;
export type BannerCopyOverride = Partial<Pick<PrivacyCopy, (typeof EDITABLE_BANNER_COPY)[number]>>;

const en: PrivacyCopy = {
  title: 'We value your privacy',
  message:
    'We use cookies and similar technologies to run this store and keep it secure. With your permission we also use them to understand how the store is used, to remember your preferences and to show you relevant ads. You can accept all, reject all, or choose.',
  accept: 'Accept all',
  decline: 'Reject all',
  manage: 'Manage preferences',
  save: 'Save my choices',
  close: 'Close',
  privacy_policy: 'Privacy policy',
  preferences_title: 'Cookie preferences',
  preferences_intro:
    'Choose which cookies this store may use. Strictly necessary cookies are always on because the store cannot work without them. You can change your mind at any time from the Cookie preferences link at the bottom of every page.',
  always_on: 'Always on',
  essential_title: 'Strictly necessary',
  essential_description: 'Needed for the store to work: your cart, checkout, signing in, security and remembering these choices.',
  preferences_category_title: 'Preferences',
  preferences_category_description: 'Remember choices you make, such as your language and region, to make the store easier to use.',
  analytics_title: 'Analytics',
  analytics_description: 'Help us understand how visitors use the store, so we can improve it. Reported in aggregate.',
  marketing_title: 'Marketing',
  marketing_description: 'Used by us and our advertising partners to show you relevant ads and to measure how well they work.',
  sale_title: 'Sale or sharing of personal data',
  sale_description: 'Allow us to share information with partners for cross-context behavioural advertising. Turn this off to opt out.',
  cookie_preferences_link: 'Cookie preferences',
  privacy_choices_link: 'Your privacy choices',
  saved: 'Your choices have been saved.',
  choices_title: 'Your privacy choices',
  choices_intro:
    'You can opt out of the sale or sharing of your personal information, including for cross-context behavioural advertising. Your choice is saved in this browser; if you have an account, sign in first so it follows you.',
  choices_opted_out: 'You have opted out of the sale and sharing of your personal information.',
  choices_opted_in: 'You have not opted out. Your information may be shared with advertising partners.',
  choices_gpc: 'Your browser sends a Global Privacy Control signal, which we honour as an opt-out.',
  choices_opt_out: 'Opt out of sale and sharing',
  choices_opt_in: 'Allow sale and sharing',
  choices_request: 'To see, correct or delete the personal data we hold about you, make a privacy request.',
  request_title: 'Privacy request',
  request_intro:
    'Ask to see a copy of the personal data we hold about you, to correct it, to delete it, or to withdraw your consent. We will email you a link to confirm the request is yours before we act on it.',
  request_email: 'Your email address',
  request_type: 'What would you like us to do?',
  request_details: 'Anything we should know (optional)',
  request_submit: 'Send request',
  request_sent: 'Check your email: we have sent a link to confirm your request. It works for 48 hours.',
  request_verified: 'Thank you — your request is confirmed. We will respond within the time the law allows and email you when it is done.',
  request_invalid: 'That link has expired or has already been used. Please make the request again.',
  request_account_hint: 'Signed in? You can also make requests from your account page.',
  request_types: {
    access: 'Send me a copy of my personal data',
    portability: 'Send me my data in a machine-readable file',
    correction: 'Correct my personal data',
    erasure: 'Delete my personal data',
    withdraw_consent: 'Withdraw my consent to marketing',
    grievance: 'Raise a concern about how my data is used',
  },
};

const hi: PrivacyCopy = {
  ...en,
  title: 'आपकी निजता हमारे लिए महत्वपूर्ण है',
  message:
    'हम इस स्टोर को चलाने और सुरक्षित रखने के लिए कुकीज़ और मिलती-जुलती तकनीकों का उपयोग करते हैं। आपकी अनुमति से हम इनका उपयोग यह समझने के लिए भी करते हैं कि स्टोर का उपयोग कैसे होता है, आपकी पसंद याद रखने और आपको उपयोगी विज्ञापन दिखाने के लिए। आप सभी स्वीकार कर सकते हैं, सभी अस्वीकार कर सकते हैं, या स्वयं चुन सकते हैं।',
  accept: 'सभी स्वीकार करें',
  decline: 'सभी अस्वीकार करें',
  manage: 'प्राथमिकताएँ चुनें',
  save: 'मेरी पसंद सहेजें',
  close: 'बंद करें',
  privacy_policy: 'गोपनीयता नीति',
  preferences_title: 'कुकी प्राथमिकताएँ',
  preferences_intro:
    'चुनें कि यह स्टोर कौन-सी कुकीज़ उपयोग कर सकता है। अनिवार्य कुकीज़ हमेशा चालू रहती हैं क्योंकि उनके बिना स्टोर काम नहीं कर सकता। आप हर पेज के नीचे दिए "कुकी प्राथमिकताएँ" लिंक से कभी भी अपनी पसंद बदल सकते हैं।',
  always_on: 'हमेशा चालू',
  essential_title: 'अनिवार्य',
  essential_description: 'स्टोर के काम करने के लिए ज़रूरी: आपका कार्ट, चेकआउट, साइन इन, सुरक्षा और आपकी ये पसंद याद रखना।',
  preferences_category_title: 'प्राथमिकताएँ',
  preferences_category_description: 'आपकी भाषा और क्षेत्र जैसी पसंद याद रखना, ताकि स्टोर उपयोग करना आसान हो।',
  analytics_title: 'विश्लेषण',
  analytics_description: 'यह समझने में मदद करता है कि लोग स्टोर का उपयोग कैसे करते हैं, ताकि हम इसे बेहतर बना सकें।',
  marketing_title: 'मार्केटिंग',
  marketing_description: 'हमारे और हमारे विज्ञापन साझेदारों द्वारा आपको उपयोगी विज्ञापन दिखाने और उनके प्रभाव को मापने के लिए।',
  sale_title: 'व्यक्तिगत डेटा की बिक्री या साझाकरण',
  sale_description: 'विज्ञापन के लिए साझेदारों के साथ जानकारी साझा करने की अनुमति। मना करने के लिए इसे बंद करें।',
  cookie_preferences_link: 'कुकी प्राथमिकताएँ',
  privacy_choices_link: 'आपकी निजता संबंधी पसंद',
  saved: 'आपकी पसंद सहेज ली गई है।',
  request_title: 'निजता अनुरोध',
  request_intro:
    'हमारे पास मौजूद अपने व्यक्तिगत डेटा की प्रति माँगें, उसे सुधारने, हटाने या मार्केटिंग के लिए दी गई सहमति वापस लेने का अनुरोध करें। कार्रवाई से पहले हम आपको पुष्टि के लिए एक लिंक ईमेल करेंगे।',
  request_email: 'आपका ईमेल पता',
  request_type: 'आप हमसे क्या करवाना चाहते हैं?',
  request_details: 'कोई और जानकारी (वैकल्पिक)',
  request_submit: 'अनुरोध भेजें',
  request_sent: 'अपना ईमेल देखें: हमने आपके अनुरोध की पुष्टि के लिए एक लिंक भेजा है। यह 48 घंटे तक काम करेगा।',
  request_verified: 'धन्यवाद — आपके अनुरोध की पुष्टि हो गई है। कार्य पूरा होने पर हम आपको ईमेल करेंगे।',
  request_invalid: 'यह लिंक समाप्त हो चुका है या पहले ही उपयोग हो चुका है। कृपया फिर से अनुरोध करें।',
  request_types: {
    access: 'मेरे व्यक्तिगत डेटा की प्रति भेजें',
    portability: 'मेरा डेटा मशीन-पठनीय फ़ाइल में भेजें',
    correction: 'मेरा व्यक्तिगत डेटा सुधारें',
    erasure: 'मेरा व्यक्तिगत डेटा हटाएँ',
    withdraw_consent: 'मार्केटिंग के लिए मेरी सहमति वापस लें',
    grievance: 'मेरे डेटा के उपयोग के बारे में शिकायत दर्ज करें',
  },
};

const de: PrivacyCopy = {
  ...en,
  title: 'Ihre Privatsphäre ist uns wichtig',
  message:
    'Wir verwenden Cookies und ähnliche Technologien, um diesen Shop zu betreiben und zu schützen. Mit Ihrer Einwilligung nutzen wir sie auch, um zu verstehen, wie der Shop genutzt wird, um Ihre Einstellungen zu speichern und Ihnen relevante Werbung zu zeigen. Sie können alle akzeptieren, alle ablehnen oder selbst wählen.',
  accept: 'Alle akzeptieren',
  decline: 'Alle ablehnen',
  manage: 'Einstellungen',
  save: 'Auswahl speichern',
  close: 'Schließen',
  privacy_policy: 'Datenschutzerklärung',
  preferences_title: 'Cookie-Einstellungen',
  preferences_intro:
    'Wählen Sie, welche Cookies dieser Shop verwenden darf. Unbedingt erforderliche Cookies sind immer aktiv. Sie können Ihre Auswahl jederzeit über den Link „Cookie-Einstellungen“ unten auf jeder Seite ändern.',
  always_on: 'Immer aktiv',
  essential_title: 'Unbedingt erforderlich',
  essential_description: 'Für den Betrieb des Shops nötig: Warenkorb, Kasse, Anmeldung, Sicherheit und das Speichern dieser Auswahl.',
  preferences_category_title: 'Präferenzen',
  preferences_category_description: 'Speichern Ihre Auswahl, etwa Sprache und Region.',
  analytics_title: 'Statistik',
  analytics_description: 'Helfen uns zu verstehen, wie der Shop genutzt wird, damit wir ihn verbessern können.',
  marketing_title: 'Marketing',
  marketing_description: 'Werden von uns und Werbepartnern genutzt, um relevante Werbung zu zeigen und ihre Wirkung zu messen.',
  cookie_preferences_link: 'Cookie-Einstellungen',
  saved: 'Ihre Auswahl wurde gespeichert.',
};

const fr: PrivacyCopy = {
  ...en,
  title: 'Nous respectons votre vie privée',
  message:
    'Nous utilisons des cookies et des technologies similaires pour faire fonctionner cette boutique et la sécuriser. Avec votre accord, nous les utilisons aussi pour comprendre comment la boutique est utilisée, mémoriser vos préférences et vous montrer des publicités pertinentes. Vous pouvez tout accepter, tout refuser ou choisir.',
  accept: 'Tout accepter',
  decline: 'Tout refuser',
  manage: 'Personnaliser',
  save: 'Enregistrer mes choix',
  close: 'Fermer',
  privacy_policy: 'Politique de confidentialité',
  preferences_title: 'Préférences en matière de cookies',
  preferences_intro:
    'Choisissez les cookies que cette boutique peut utiliser. Les cookies strictement nécessaires sont toujours actifs. Vous pouvez changer d’avis à tout moment via le lien « Préférences cookies » en bas de chaque page.',
  always_on: 'Toujours actifs',
  essential_title: 'Strictement nécessaires',
  essential_description: 'Indispensables au fonctionnement : panier, paiement, connexion, sécurité et mémorisation de ces choix.',
  preferences_category_title: 'Préférences',
  preferences_category_description: 'Mémorisent vos choix, comme la langue et la région.',
  analytics_title: 'Mesure d’audience',
  analytics_description: 'Nous aident à comprendre l’utilisation de la boutique pour l’améliorer.',
  marketing_title: 'Marketing',
  marketing_description: 'Utilisés par nous et nos partenaires publicitaires pour afficher des publicités pertinentes et mesurer leur efficacité.',
  cookie_preferences_link: 'Préférences cookies',
  saved: 'Vos choix ont été enregistrés.',
};

const es: PrivacyCopy = {
  ...en,
  title: 'Valoramos tu privacidad',
  message:
    'Usamos cookies y tecnologías similares para que esta tienda funcione y sea segura. Con tu permiso, también las usamos para entender cómo se usa la tienda, recordar tus preferencias y mostrarte anuncios relevantes. Puedes aceptar todas, rechazar todas o elegir.',
  accept: 'Aceptar todas',
  decline: 'Rechazar todas',
  manage: 'Configurar',
  save: 'Guardar mis opciones',
  close: 'Cerrar',
  privacy_policy: 'Política de privacidad',
  preferences_title: 'Preferencias de cookies',
  preferences_intro:
    'Elige qué cookies puede usar esta tienda. Las estrictamente necesarias siempre están activas. Puedes cambiar de opinión cuando quieras desde el enlace «Preferencias de cookies» al pie de cada página.',
  always_on: 'Siempre activas',
  essential_title: 'Estrictamente necesarias',
  essential_description: 'Necesarias para que la tienda funcione: carrito, pago, inicio de sesión, seguridad y recordar estas opciones.',
  preferences_category_title: 'Preferencias',
  preferences_category_description: 'Recuerdan tus elecciones, como el idioma y la región.',
  analytics_title: 'Analítica',
  analytics_description: 'Nos ayudan a entender cómo se usa la tienda para mejorarla.',
  marketing_title: 'Marketing',
  marketing_description: 'Las usamos nosotros y nuestros socios publicitarios para mostrarte anuncios relevantes y medir su eficacia.',
  cookie_preferences_link: 'Preferencias de cookies',
  privacy_choices_link: 'Tus opciones de privacidad',
  saved: 'Tus opciones se han guardado.',
};

const BUILT_IN: Record<string, PrivacyCopy> = { en, hi, de, fr, es };

/** The wording for a language ('hi', 'pt-br' → 'pt'), with the merchant's banner rewording on top. */
export function privacyCopy(locale: string | null | undefined, overrides?: Record<string, BannerCopyOverride> | null): PrivacyCopy {
  const code = (locale ?? 'en').toLowerCase();
  const base = BUILT_IN[code] ?? BUILT_IN[code.split('-')[0]] ?? en;
  const custom = overrides?.[code] ?? overrides?.[code.split('-')[0]] ?? null;
  if (!custom) return base;
  const merged: PrivacyCopy = { ...base };
  for (const key of EDITABLE_BANNER_COPY) {
    const value = custom[key];
    if (typeof value === 'string' && value.trim()) merged[key] = value.trim();
  }
  return merged;
}

export const PRIVACY_COPY_LOCALES = Object.keys(BUILT_IN);
