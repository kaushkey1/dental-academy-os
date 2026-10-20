export interface WebsiteIntegration {
  academy: { name: string; slug: string; currency: string };
  development: boolean;
  baseUrl: string;
  learnerUrl: string;
  publishableKey: string | null;
  allowedOrigins: string[];
  keyUpdatedAt: string | null;
  programs?: { id: string; title: string; slug: string }[];
  offerings: { id: string; title: string; kind: string }[];
}

export const websiteEndpoints = [
  {
    path: 'programs',
    method: 'GET',
    label: 'Programs',
    description: 'Published program descriptions, faculty and credits.',
  },
  {
    path: 'runs',
    method: 'GET',
    label: 'Workshops',
    description: 'Workshop dates, venues, tickets and available seats.',
  },
  {
    path: 'courses',
    method: 'GET',
    label: 'Online courses',
    description: 'Published course listings and access prices.',
  },
  {
    path: 'programs/:reference',
    method: 'GET',
    label: 'Program details page',
    description: 'One published program by ID or slug, with formatted catalog content.',
  },
  {
    path: 'runs/:reference',
    method: 'GET',
    label: 'Workshop details page',
    description: 'One published workshop by ID or slug, with page content, dates and tickets.',
  },
  {
    path: 'courses/:reference',
    method: 'GET',
    label: 'Course details page',
    description: 'One published course by ID or slug, with page content and access prices.',
  },
  {
    path: 'courses/:reference/curriculum',
    method: 'GET',
    label: 'Course modules & lessons',
    description:
      'Public module and lesson titles, video durations and free-preview availability. Paid lesson bodies are excluded.',
  },
  {
    path: 'courses/:reference/lessons/:lessonId/preview',
    method: 'GET',
    label: 'Free lesson preview',
    description:
      'Published text content or a short-lived video playback URL for a lesson explicitly marked free.',
  },
  {
    path: 'courses/:reference/lessons/:lessonId/document',
    method: 'GET',
    label: 'Free PDF preview',
    description:
      'PDF bytes for a free-preview lesson. Fetch with the publishable-key header; no login or payment required.',
  },
  { path: 'offers', method: 'GET', label: 'Offers', description: 'Current public discount codes.' },
  {
    path: 'faculty',
    method: 'GET',
    label: 'Faculty',
    description: 'Faculty profiles from published programs.',
  },
  {
    path: 'checkout-sessions',
    method: 'POST',
    label: 'Checkout link',
    description: 'Get a hosted booking URL for an open workshop or course.',
  },
  {
    path: 'inquiries',
    method: 'POST',
    label: 'Inquiry / waitlist',
    description: 'Send a website enquiry to this academy’s lead inbox.',
  },
] as const;
export type WebsiteOperation = (typeof websiteEndpoints)[number]['path'];

export function websiteExampleBody(operation: WebsiteOperation, offeringId: string) {
  if (operation === 'checkout-sessions')
    return {
      offeringId: offeringId || 'YOUR_OFFERING_ID',
      urlParams: { utm_source: 'academy_website' },
    };
  if (operation === 'inquiries')
    return {
      name: 'Website visitor',
      mobile: '+919876543210',
      email: 'visitor@example.com',
      message: 'Please share more information about this program.',
      ...(offeringId ? { offeringId } : {}),
      waitlist: false,
      urlParams: { utm_source: 'academy_website' },
    };
  return undefined;
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function websiteSnippet(
  info: WebsiteIntegration,
  operation: WebsiteOperation,
  language: 'javascript' | 'curl',
  offeringId = '',
  lessonId = 'LESSON_ID_FROM_CURRICULUM',
) {
  const body = websiteExampleBody(operation, offeringId);
  const key = info.publishableKey || 'YOUR_PUBLISHABLE_KEY';
  const detail = operation.includes('/:reference');
  const candidates = operation.startsWith('programs/')
    ? info.programs || []
    : info.offerings.filter(
        (o) => o.kind === (operation.startsWith('courses/') ? 'course' : 'workshop'),
      );
  const reference =
    candidates.find((item) => item.id === offeringId)?.id || candidates[0]?.id || 'YOUR_ID_OR_SLUG';
  const url = `${info.baseUrl}/${operation.replace(':reference', encodeURIComponent(reference)).replace(':lessonId', encodeURIComponent(lessonId || 'LESSON_ID_FROM_CURRICULUM'))}`;
  if (language === 'curl')
    return `curl --fail-with-body ${shellQuote(url)} \\\n  -H ${shellQuote('X-Publishable-Key: ' + key)}${body ? ` \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify(body, null, 2))}` : ''}`;
  if (operation.endsWith('/document'))
    return `const response = await fetch(${JSON.stringify(url)}, {
  credentials: 'omit',
  headers: { 'X-Publishable-Key': ${JSON.stringify(key)} }
});
if (!response.ok) throw new Error((await response.json()).error);
const pdfUrl = URL.createObjectURL(await response.blob());
// Use pdfUrl in your PDF viewer/download link. Revoke it when the viewer closes.
// URL.revokeObjectURL(pdfUrl);`;
  return `const response = await fetch(${JSON.stringify(url)}, {
  method: ${JSON.stringify(body ? 'POST' : 'GET')},
  credentials: 'omit',
  headers: {
    'X-Publishable-Key': ${JSON.stringify(key)}${body ? ",\n    'Content-Type': 'application/json'" : ''}
  }${body ? `,\n  body: JSON.stringify(${JSON.stringify(body, null, 2).replaceAll('\n', '\n  ')})` : ''}
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || 'API request failed');
${operation === 'checkout-sessions' ? 'window.location.assign(result.checkoutUrl);' : operation === 'inquiries' ? '// Show your visitor a confirmation when result.received is true.\nconsole.log(result.received);' : operation.endsWith('/curriculum') ? '// Group by module, show all lesson titles, and enable Preview only for freePreview lessons.\nconsole.log(result.data.modules);' : operation.endsWith('/preview') ? '// Text: render result.data.content.html (generated by the API).\n// Video: load result.data.playback.url in an HLS player. It expires after 15 minutes.\n// PDF: fetch the document endpoint with the same header.\nconsole.log(result.data);' : detail ? '// Add these elements to your website template.\ndocument.querySelector("[data-catalog-title]").textContent = result.data.title;\n// details.html is generated by the API from validated rich text.\ndocument.querySelector("[data-catalog-details]").innerHTML = result.data.details.html;' : '// Render these records using textContent or your framework’s escaped text output.\n// Follow each record’s detailsUrl for the full page content.\nconsole.log(result.data);'}`;
}

export function websiteGuide(info: WebsiteIntegration) {
  const offeringId = info.offerings[0]?.id || '';
  return `# ${info.academy.name} — website integration

Environment: ${info.development ? 'LOCAL DEVELOPMENT — these URLs only work on the computer running the app.' : 'Deployed environment'}
API base URL: ${info.baseUrl}
Academy slug: ${info.academy.slug}
Publishable key: ${info.publishableKey || 'Create a key in Academy settings first.'}
Learner portal: ${info.learnerUrl}
Allowed website origins: ${info.allowedOrigins.join(', ') || 'None configured yet'}

## Connect your website

1. Add each exact website origin in Academy settings → Website & API (include www separately).
2. Send X-Publishable-Key on every request. Do not send staff session cookies.
3. Use the catalog to render listings and the checkout endpoint for your booking button.
4. Test from the website itself to verify its origin is allowed.

This is a publishable, browser-safe key for this academy’s public catalog, checkout links and enquiries.
It does not grant staff access, expose learner records or authorize payments.
Allowed origins control browser access; server-to-server integrations can send the key without an Origin header.
Never put payment-provider or server secrets in website code. Replacing a key invalidates the old one immediately.
After deployment, copy the updated base URL and examples from settings. Do not publish localhost URLs.

## API contract

GET lists: { "version": "v1", "data": [...] }. Lists are not paginated yet; runs/courses return at most 200 offerings combined.
GET programs/:reference, runs/:reference, courses/:reference: { "version": "v1", "data": { ... } }. Use an ID or slug, or follow a listing's detailsUrl. Detail lookups are not limited by the listing's 200-item cap.
The details object includes format (rich-text-v1), document (validated rich-text JSON), text (plain text) and html (escaped, allowlisted HTML generated by this API).
details.source is custom, program or description: workshops/courses inherit program content unless they have their own details; otherwise the program's short description is used.
The short description remains plain text for cards. Lists contain detailsUrl instead of the full document. Catalog detail responses exclude lesson bodies, drafts and unpublished offerings.
Render details.html inside your own styled page container, or render details.document with your framework. Only insert the API-generated details.html as HTML; use escaped text for titles, descriptions and other fields. Arbitrary HTML, scripts, embeds and image uploads are not accepted in catalog text.
Page content is edited in the program or offering builder. Saving a published item updates its public page immediately; draft and archived items stay private.
Ticket price and deposit are integer minor currency units (paise/cents); divide by 100 for display. Currency: ${info.academy.currency}.
Read offering.status before showing a booking button; only open offerings accept checkout links. Seats are reserved during hosted checkout, not when a link is generated.
POST checkout-sessions: { offeringId, urlParams? } → 201 { checkoutUrl }. This creates a URL, not a paid order.
POST inquiries: { name, mobile, email, message, offeringId?, waitlist?, urlParams? } → 201 { received: true }.
Use an international mobile number. email may be an empty string; message is required (up to 3000 characters).
Set waitlist: true to create a waitlist lead. Inquiry submission does not enroll or reserve a seat.
urlParams is an optional object with up to 40 string values. Use it for campaign tracking.
Errors: { error, code }. 400 invalid input; 401 invalid key; 403 website origin denied; 404 unpublished/missing resource; 429 rate limit.
Current limits: 240 API requests/minute/IP per server instance; additionally 20 v1 enquiries/10 minutes/IP per instance. Back off on 429; do not blindly retry enquiry submissions.
GET courses/:reference/curriculum groups published lessons into modules with title, kind, durationSeconds and freePreview. Paid lesson content, media identifiers, quiz answers, learner progress and private drafts are never included.
GET courses/:reference/lessons/:lessonId/preview returns content only for an explicitly free lesson of a publicly listed course. Text has content.html/document/text; video has playback.url/expiresAt. Video URLs expire after 15 minutes; request a fresh preview if playback expires. A previously issued video URL may remain usable until its expiry after preview access is removed.
GET courses/:reference/lessons/:lessonId/document returns application/pdf bytes only for a free PDF lesson. Fetch with X-Publishable-Key; use a Blob URL with your viewer and revoke it on close. Do not put API keys in query strings. Public previews can be downloaded by visitors; already downloaded material cannot be recalled.
Staff configure module/lesson preview access in the course curriculum. All lessons start private; new lessons added to a free module are still private until explicitly selected. Archiving a lesson turns its preview off. Saving a draft does not update its public preview; publishing does. Removing free access blocks new preview/document requests immediately. Closing enrollment keeps a publicly listed course's previews available; archiving or unpublishing the course/program removes them.
Public previews require neither sign-in nor purchase and do not create enrollment, progress, assessment access or certificates. Video playback requires configured Mux signing and the external website domain included in the provider's playback restrictions. Outbound webhook subscriptions are not available yet.

${websiteEndpoints
  .map(
    (endpoint) => `## ${endpoint.method} /${endpoint.path}

${endpoint.description}

\`\`\`javascript
${websiteSnippet(info, endpoint.path, 'javascript', offeringId)}
\`\`\`

\`\`\`sh
${websiteSnippet(info, endpoint.path, 'curl', offeringId)}
\`\`\``,
  )
  .join('\n\n')}
`;
}
