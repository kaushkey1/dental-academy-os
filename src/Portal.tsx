import { PolicyTerms } from './CancellationPolicy';
import { RichTextContent } from './RichTextContent';
import { BuyerBillingFields, buyerBillingFromForm } from './Billing';
import { PaymentDetails, PaymentModal } from './PaymentDetails';
import { LearnerPostTest } from './LearnerPostTest';
import { TextLessonReader } from './TextLessonReader';
import { LearningUpdates } from './LearningUpdates';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Award,
  BookOpen,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Download,
  LogOut,
  MapPin,
  Play,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import {
  api,
  type Row,
  money,
  date,
  Button,
  Field,
  Form,
  PageHeading,
  Badge,
  Status,
  Empty,
  Modal,
  ExternalLink,
} from './shared';
import { Login } from './App';
const PdfReader = lazy(() => import('./PdfReader'));
function PortalHeader({ name, action }: { name: string; action?: React.ReactNode }) {
  return (
    <header className="portal-header">
      <a href="/" className="brand">
        <div className="brand-icon">
          a<span>·</span>
        </div>
        <span>{name}</span>
      </a>
      {action || <span className="powered">Powered by academy OS</span>}
    </header>
  );
}
export function Checkout({
  slug,
  offeringSlug,
  identity,
  reloadIdentity,
}: {
  slug: string;
  offeringSlug: string;
  identity: Row | null | undefined;
  reloadIdentity: () => void;
}) {
  const [catalog, setCatalog] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [ticketId, setTicketId] = useState(''),
    [quantity, setQuantity] = useState(1),
    [step, setStep] = useState(1),
    [order, setOrder] = useState<Row | null>(null),
    [profile, setProfile] = useState<Row | null>(null),
    [deposit, setDeposit] = useState(false),
    [coupon, setCoupon] = useState('');
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    api('/public/' + slug + '/catalog')
      .then((c) => {
        setCatalog(c);
        const o = c.offerings.find((o: Row) => o.slug === offeringSlug);
        if (o) {
          const choices = o.tickets.filter(
            (t: Row) =>
              t.on_sale &&
              (t.seats_left === null || t.seats_left >= t.min_quantity) &&
              (o.kind === 'course' || o.seats_left >= t.min_quantity),
          );
          const ticket = choices.find((v: Row) => v.min_quantity === 1) || choices[0];
          setTicketId(ticket?.id || '');
          setQuantity(ticket?.min_quantity || 1);
        }
      })
      .catch((e) => setError(e.message));
  }, [slug, offeringSlug]);
  useEffect(() => {
    if (identity?.role === 'learner' && identity.tenant.slug === slug) {
      api('/learner/dashboard')
        .then((d) => setProfile(d.contact))
        .catch((e) => setError(e.message));
      const orderId = new URLSearchParams(location.search).get('order');
      if (orderId)
        api('/learner/orders/' + orderId)
          .then((o) => {
            setOrder(o);
            setStep(4);
          })
          .catch((e) => setError(e.message));
    }
  }, [identity, slug]);
  if (!catalog) return <div className="loading">{error || 'Loading the academy…'}</div>;
  const o = catalog.offerings.find((o: Row) => o.slug === offeringSlug),
    t = catalog.tenant;
  if (!o)
    return (
      <div className="portal">
        <PortalHeader name={t.name} />
        <main className="catalog-page">
          <PageHeading
            title="Find your next chapter."
            subtitle="Explore upcoming workshops and self-paced learning."
          />
          <div className="program-grid">
            {catalog.offerings.map((p: Row) => (
              <a className="panel catalog-card" key={p.id} href={`/book/${slug}/${p.slug}`}>
                <Badge>{p.kind === 'course' ? 'Online course' : 'Workshop'}</Badge>
                <h2>{p.title}</h2>
                <p>
                  {date(p.starts_at, t)} · {p.credits} credits
                </p>
                <strong>
                  {p.status === 'open' &&
                  p.tickets.some(
                    (v: Row) =>
                      v.on_sale && (v.seats_left === null || v.seats_left >= v.min_quantity),
                  )
                    ? 'From ' +
                      money(
                        p.tickets.filter(
                          (v: Row) =>
                            v.on_sale && (v.seats_left === null || v.seats_left >= v.min_quantity),
                        )[0].price,
                        t,
                      )
                    : 'Bookings unavailable'}
                </strong>
                <ArrowRight size={18} />
              </a>
            ))}
          </div>
        </main>
      </div>
    );
  const ticket = o.tickets.find((v: Row) => v.id === ticketId),
    signedIn = identity?.role === 'learner' && identity.tenant.slug === slug;
  if (step === 2 && !signedIn)
    return (
      <>
        <div className="checkout-back">
          <button className="text-button" onClick={() => setStep(1)}>
            ← Back to workshop
          </button>
        </div>
        {identity ? (
          <div className="loading">
            <p>Sign out of your current workspace to continue as a learner at {t.name}.</p>
            <Button
              onClick={async () => {
                await api('/auth/logout', 'POST');
                reloadIdentity();
              }}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <Login
            slug={slug}
            learner
            onLogin={() => {
              reloadIdentity();
              setStep(3);
            }}
          />
        )}
      </>
    );
  const maxQuantity = Math.min(
    o.kind === 'course' ? 20 : o.seats_left,
    ticket?.seats_left ?? 20,
    20,
  );
  const available = Boolean(ticket?.on_sale) && maxQuantity >= (ticket?.min_quantity || 1);
  const validQuantity =
    Number.isInteger(quantity) &&
    quantity >= (ticket?.min_quantity || 1) &&
    quantity <= maxQuantity;
  return (
    <div className="portal">
      <PortalHeader
        name={t.name}
        action={
          signedIn ? (
            <a className="text-button" href={'/learn/' + slug}>
              My learning <ArrowRight size={16} />
            </a>
          ) : undefined
        }
      />
      <main className="checkout-layout">
        <section className="checkout-main">
          <a className="text-button back-link" href={'/book/' + slug}>
            ← All offerings
          </a>
          <div className="eyebrow">{o.specialty}</div>
          <h1>{o.title}</h1>
          <div className="checkout-meta">
            <span>
              <CalendarDays size={17} />
              {o.kind === 'course'
                ? 'Learn at your own pace'
                : date(o.starts_at, t) + ' – ' + date(o.ends_at, t)}
            </span>
            <span>
              <MapPin size={17} />
              {o.venue}
            </span>
            <span>
              <Award size={17} />
              {o.credits} {o.credit_type} credits
            </span>
          </div>
          <section className="catalog-page-content" aria-label="About this offering">
            <RichTextContent
              format={o.details?.format}
              document={o.details?.document}
              plain={o.description || ''}
            />
          </section>
          {o.objectives?.length > 0 && (
            <section className="learning-objectives">
              <h2>What you’ll learn</h2>
              <ul>
                {o.objectives.map((objective: string, n: number) => (
                  <li key={n}>{objective}</li>
                ))}
              </ul>
            </section>
          )}
          <div className="checkout-steps">
            {['Choose', 'Verify', 'Details', 'Payment'].map((name, n) => (
              <div className={step >= n + 1 ? 'current' : ''} key={name}>
                <i>{step > n + 1 ? <Check size={12} /> : n + 1}</i>
                {name}
              </div>
            ))}
          </div>
          {step === 1 && (
            <section className="panel checkout-panel">
              <h2>Make room for your next chapter.</h2>
              <p className="muted">
                {o.kind === 'workshop'
                  ? `${o.seats_left} seats currently available. Your seat is held for 15 minutes at payment.`
                  : 'Secure access to your course, lessons and post-test.'}
              </p>
              {o.tickets.map((ticket: Row) => (
                <label
                  className={'ticket-choice ' + (ticketId === ticket.id ? 'chosen' : '')}
                  key={ticket.id}
                >
                  <input
                    type="radio"
                    name="ticket"
                    checked={ticketId === ticket.id}
                    disabled={
                      !ticket.on_sale ||
                      (ticket.seats_left !== null && ticket.seats_left < ticket.min_quantity) ||
                      (o.kind === 'workshop' && o.seats_left < ticket.min_quantity)
                    }
                    onChange={() => {
                      setTicketId(ticket.id);
                      setQuantity(ticket.min_quantity);
                      setDeposit(false);
                    }}
                  />
                  <div>
                    <strong>{ticket.name}</strong>
                    <small>
                      {ticket.min_quantity > 1
                        ? 'Minimum ' + ticket.min_quantity + ' learners'
                        : 'For dental professionals'}
                    </small>
                    <small>
                      {!ticket.on_sale
                        ? ticket.sale_starts && new Date(ticket.sale_starts) > new Date()
                          ? 'On sale from ' +
                            new Date(ticket.sale_starts).toLocaleString(t.locale, {
                              timeZone: t.timezone,
                            }) +
                            ' (' +
                            t.timezone +
                            ')'
                          : 'Sale ended'
                        : ticket.seats_left !== null
                          ? ticket.seats_left < ticket.min_quantity
                            ? 'This ticket tier is sold out'
                            : ticket.seats_left + ' seats left at this price'
                          : ticket.sale_ends
                            ? 'Available until ' +
                              new Date(ticket.sale_ends).toLocaleString(t.locale, {
                                timeZone: t.timezone,
                              }) +
                              ' (' +
                              t.timezone +
                              ')'
                            : 'Available now'}
                    </small>
                  </div>
                  <strong>{money(ticket.price, t)}</strong>
                </label>
              ))}
              {(o.kind === 'workshop' || ticket?.min_quantity > 1) && (
                <Field label="Number of seats">
                  <input
                    type="number"
                    min={ticket?.min_quantity || 1}
                    max={maxQuantity}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </Field>
              )}
              {available && !validQuantity && (
                <p className="error" role="alert">
                  Choose a whole number from {ticket?.min_quantity || 1} to {maxQuantity} seats for
                  this ticket.
                </p>
              )}
              {quantity > 1 && validQuantity && (
                <div className="notice">
                  Your order will reserve {quantity} seats. You can assign the additional seats to
                  your colleagues from your learner dashboard after payment.
                </div>
              )}
              <Button
                disabled={
                  !available ||
                  o.status !== 'open' ||
                  !Number.isInteger(quantity) ||
                  quantity < (ticket?.min_quantity || 1) ||
                  quantity > maxQuantity
                }
                onClick={() => setStep(signedIn ? 3 : 2)}
              >
                {available && o.status === 'open' ? 'Continue to booking' : 'Booking unavailable'}
                <ArrowRight size={16} />
              </Button>
            </section>
          )}
          {step === 3 && signedIn && (
            <section className="panel checkout-panel">
              <h2>Your professional details.</h2>
              <p className="muted">
                Your license is reviewed by the academy before a certificate can be issued.
              </p>
              <Form
                label="Continue to payment"
                onSubmit={async (d) => {
                  await api('/learner/profile', 'PUT', {
                    name: d.get('name'),
                    email: d.get('email'),
                    clinic: d.get('clinic'),
                    licenseNumber: d.get('licenseNumber'),
                    licenseCouncil: d.get('licenseCouncil'),
                    messagingConsent: d.get('consent') === 'on',
                  });
                  setStep(4);
                }}
              >
                <Field label="Full name (as it should appear on your certificate)">
                  <input name="name" defaultValue={profile?.name || ''} required />
                </Field>
                <div className="form-grid">
                  <Field label="Email">
                    <input name="email" type="email" defaultValue={profile?.email || ''} required />
                  </Field>
                  <Field label="Clinic or practice">
                    <input name="clinic" defaultValue={profile?.clinic || ''} />
                  </Field>
                </div>
                <div className="form-grid">
                  <Field label="License / registration number">
                    <input
                      name="licenseNumber"
                      defaultValue={profile?.license_number || ''}
                      required
                    />
                  </Field>
                  <Field label="Issuing council or state">
                    <input
                      name="licenseCouncil"
                      defaultValue={profile?.license_council || ''}
                      required
                    />
                  </Field>
                </div>
                <label className="checkbox">
                  <input
                    name="consent"
                    type="checkbox"
                    defaultChecked={profile?.messaging_consent || false}
                  />
                  I agree to receive workshop and course updates by message. I can opt out.
                </label>
              </Form>
            </section>
          )}
          {step === 4 && (
            <section className="panel checkout-panel">
              <h2>{order?.paid > 0 ? 'Your payment status.' : 'One step closer.'}</h2>
              {order ? (
                <>
                  <PaymentDetails orderId={order.id} tenant={t} />
                  <a className="button secondary spaced" href={'/learn/' + slug}>
                    Open my learning <ArrowRight size={16} />
                  </a>
                </>
              ) : (
                <Form
                  label="Reserve and review order"
                  onSubmit={async (f) => {
                    const result = await api('/learner/orders', 'POST', {
                      offeringId: o.id,
                      ticketId,
                      quantity,
                      deposit,
                      coupon: coupon || undefined,
                      idempotencyKey: key.current,
                      urlParams: Object.fromEntries(new URLSearchParams(location.search)),
                      billing: buyerBillingFromForm(f, t),
                      cancellationPolicyRevision:
                        catalog.cancellationPolicy?.config.active && f.has('acceptCancellation')
                          ? catalog.cancellationPolicy.revision
                          : undefined,
                    });
                    setOrder(result);
                  }}
                >
                  {ticket?.deposit && (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={deposit}
                        onChange={(e) => setDeposit(e.target.checked)}
                      />
                      Pay a deposit of {money(ticket.deposit * quantity, t)}
                    </label>
                  )}
                  <Field label="Coupon (optional)">
                    <input value={coupon} onChange={(e) => setCoupon(e.target.value)} />
                  </Field>
                  {catalog.cancellationPolicy?.config.active && (
                    <>
                      <details>
                        <summary>Cancellation &amp; refund terms</summary>
                        <PolicyTerms policy={catalog.cancellationPolicy} />
                      </details>
                      <label className="checkbox">
                        <input type="checkbox" name="acceptCancellation" required />I have read and
                        accept cancellation policy version {catalog.cancellationPolicy.revision},
                        including the rules for all seats in this booking.
                      </label>
                    </>
                  )}
                  <h3>Billing details</h3>
                  <BuyerBillingFields tenant={t} value={{ name: profile?.name || '' }} />
                  <p className="muted">
                    Your final total and tax lines are calculated on the server before payment.
                  </p>
                </Form>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}
        </section>
        <aside className="checkout-sidebar">
          <div className="panel">
            <div className="course-mini-art">
              <BookOpen size={48} strokeWidth={1} />
              <span>INVEST IN YOUR NEXT CHAPTER</span>
            </div>
            <div className="checkout-summary">
              <Badge>{o.kind === 'course' ? 'Self-paced course' : 'Hands-on workshop'}</Badge>
              <h3>{o.title}</h3>
              <div className="setting-row">
                <span>{ticket?.name}</span>
                <strong>{money(ticket?.price || 0, t)}</strong>
              </div>
              <div className="setting-row">
                <span>Quantity</span>
                <strong>{quantity}</strong>
              </div>
              <div className="setting-row total">
                <span>{order ? 'Order total' : 'Subtotal'}</span>
                <strong>{money(order?.total ?? (ticket?.price || 0) * quantity, t)}</strong>
              </div>
              {order?.tax_lines?.map((l: Row) => (
                <div className="setting-row" key={l.name}>
                  <span>{l.name}</span>
                  <span>{money(l.amount, t)}</span>
                </div>
              ))}
              <div className="secure-note">
                <ShieldCheck size={17} />
                <span>Payments go directly to the academy through its payment provider.</span>
              </div>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
export function LearnerPortal({ identity, logout }: { identity: Row; logout: () => void }) {
  const [data, setData] = useState<Row | null>(null),
    [course, setCourse] = useState<Row | null>(null),
    [feedback, setFeedback] = useState<Row | null>(null),
    [paymentOrder, setPaymentOrder] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [groupSeats, setGroupSeats] = useState<Row[]>([]),
    [assignSeat, setAssignSeat] = useState<Row | null>(null);
  const load = () =>
    Promise.all([api('/learner/dashboard'), api('/learner/group-seats')])
      .then(([d, g]) => {
        setData(d);
        setGroupSeats(g);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!data) return <div className="loading">{error || 'Opening your learning journey…'}</div>;
  const t = data.tenant;
  return (
    <div className="portal learner-portal">
      {identity.demo && (
        <div className="environment-strip">
          Demo workspace · Sample learning records · Changes are shared with other reviewers
        </div>
      )}
      <PortalHeader
        name={t.name}
        action={
          <button className="text-button" onClick={logout}>
            <LogOut size={16} />
            Sign out
          </button>
        }
      />
      <main className="learner-main">
        {course ? (
          <CoursePlayer
            enrollment={course}
            tenant={t}
            onBack={() => {
              setCourse(null);
              load();
            }}
          />
        ) : (
          <>
            <PageHeading
              eyebrow="YOUR LEARNING JOURNEY"
              title={`Welcome back${data.contact.name ? ', ' + data.contact.name.replace('Dr. ', '').split(' ')[0] : ''}.`}
              subtitle="Your next chapter is waiting. Pick up where you left off."
              action={
                <a href={'/book/' + t.slug} className="button secondary">
                  Explore learning <ArrowRight size={16} />
                </a>
              }
            />
            <LearningUpdates
              tenant={t}
              onOpen={async (item) => {
                const fresh = await api('/learner/dashboard');
                setData(fresh);
                const enrollment = fresh.enrollments.find((e: Row) => e.id === item.enrollment_id);
                if (item.kind !== 'certificate_ready' && enrollment?.access?.allowed)
                  setCourse(enrollment);
                else
                  document
                    .getElementById(
                      item.kind === 'certificate_ready' ? 'my-certificates' : 'my-courses',
                    )
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
            {data.orders?.length > 0 && (
              <section className="panel booking-summary">
                <h2>My bookings & payments</h2>
                {data.orders.map((o: Row) => (
                  <div className="payment-record" key={o.id}>
                    <div>
                      <strong>{o.title}</strong>
                      <small>
                        Order {o.id.slice(0, 8).toUpperCase()} · <Status value={o.status} />
                      </small>
                      {o.cancellation_pending && (
                        <p className="notice">Cancellation requested · awaiting academy review</p>
                      )}
                      {o.status === 'partial' && !o.cancellation_pending && (
                        <p>
                          Balance: <strong>{money(o.total - o.paid, t)}</strong>
                          {o.balance_due_at
                            ? ' · Due ' + date(o.balance_due_at, t)
                            : ' · Due date not recorded'}
                        </p>
                      )}
                    </div>
                    <Button secondary onClick={() => setPaymentOrder(o)}>
                      View payment
                    </Button>
                  </div>
                ))}
              </section>
            )}
            {paymentOrder && (
              <PaymentModal
                order={paymentOrder}
                tenant={t}
                onClose={() => setPaymentOrder(null)}
                onUpdated={load}
              />
            )}
            <>
              {groupSeats.length > 0 && (
                <section className="panel">
                  <div className="panel-title">
                    <h2>Assign your group seats</h2>
                    <Badge tone="amber">{groupSeats.length} unassigned</Badge>
                  </div>
                  {groupSeats.map((s) => (
                    <div className="certificate-row" key={s.id}>
                      <UsersRound size={23} />
                      <div>
                        <strong>{s.title}</strong>
                        <small>Seat {s.seat_number}</small>
                      </div>
                      <Button secondary onClick={() => setAssignSeat(s)}>
                        Assign learner
                      </Button>
                    </div>
                  ))}
                </section>
              )}
            </>
            <div className="section-heading">
              <h2>My workshops</h2>
            </div>
            {!data.enrollments.some((e: Row) => e.kind === 'workshop') && (
              <p className="muted">
                Your workshop bookings, schedules and included learning will appear here.
              </p>
            )}
            <div className="program-grid">
              {data.enrollments
                .filter((e: Row) => e.kind === 'workshop')
                .map((e: Row) => (
                  <div className="panel learner-card" key={e.id}>
                    <CalendarDays size={25} />
                    <Status value={e.state} />
                    <h2>{e.title}</h2>
                    <p>
                      {date(e.starts_at, t)} – {date(e.ends_at, t)}
                    </p>
                    <p>
                      <MapPin size={14} />
                      {e.venue}
                    </p>
                    <div className="program-meta">
                      <span>{e.credits} credits</span>
                      <Badge>
                        {data.contact.license_status === 'verified'
                          ? 'License verified'
                          : 'License pending'}
                      </Badge>
                    </div>
                    <Button secondary onClick={() => setFeedback(e)}>
                      {e.feedback_at ? 'Update feedback' : 'Submit feedback'}
                    </Button>
                    {e.included_courses?.length > 0 && (
                      <div className="included-courses">
                        <h3>Included learning</h3>
                        {e.included_courses.map((link: Row) => {
                          const c = data.enrollments.find((v: Row) => v.id === link.enrollment_id);
                          return (
                            <div key={link.id}>
                              <strong>{link.title}</strong>
                              <p>
                                {link.purpose === 'prework' ? 'Pre-work' : 'Recordings'} ·{' '}
                                {c?.access.allowed && !link.revoked_at
                                  ? 'Ready to open'
                                  : link.enrollment_id
                                    ? 'Access ended or unavailable'
                                    : link.purpose === 'prework'
                                      ? 'Unlocks after payment'
                                      : 'Unlocks after all workshop sessions'}
                              </p>
                              {c?.access.allowed && !link.revoked_at && (
                                <Button secondary onClick={() => setCourse(c)}>
                                  Open included course
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
            </div>
            <div className="section-heading">
              <h2 id="my-courses" tabIndex={-1}>
                My courses
              </h2>
            </div>
            {!data.enrollments.some((e: Row) => e.kind === 'course') && (
              <p className="muted">
                Courses you purchase or receive from your academy will appear here.
              </p>
            )}
            <div className="program-grid">
              {data.enrollments
                .filter((e: Row) => e.kind === 'course')
                .map((e: Row) => (
                  <div className="panel learner-card" key={e.id}>
                    <BookOpen size={25} />
                    <Status value={e.state} />
                    <h2>{e.title}</h2>
                    <p>{e.credits} credits · Self-paced</p>
                    <p>
                      {e.access.allowed
                        ? 'Access ' +
                          (e.access.expires_at
                            ? 'until ' + date(e.access.expires_at, t)
                            : 'for life')
                        : `Access ${e.access.status}. Your progress and certificates are retained.`}
                    </p>
                    {e.access.sources
                      .filter((s: Row) => s.active)
                      .map((s: Row, n: number) => (
                        <small key={s.id || n}>{s.label}</small>
                      ))}
                    <p>
                      {e.progress.completed} / {e.progress.total} lessons complete
                    </p>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label={`${e.title} lesson progress`}
                      aria-valuemin={0}
                      aria-valuemax={e.progress.total || 1}
                      aria-valuenow={e.progress.completed}
                    >
                      <i
                        style={{
                          width:
                            (e.progress.total
                              ? (100 * e.progress.completed) / e.progress.total
                              : 0) + '%',
                        }}
                      />
                    </div>
                    {e.access.allowed ? (
                      <Button onClick={() => setCourse(e)}>
                        Continue learning <Play size={15} />
                      </Button>
                    ) : (
                      <a className="button secondary" href={`/book/${t.slug}/${e.slug}`}>
                        View access options
                      </a>
                    )}
                  </div>
                ))}
            </div>
            {!data.enrollments.length && (
              <div className="panel">
                <Empty
                  title="Your learning journey starts here."
                  description="Explore the academy’s workshops and courses to find your next chapter."
                  action={
                    <a className="button" href={'/book/' + t.slug}>
                      Explore courses
                    </a>
                  }
                />
              </div>
            )}
            <div className="section-heading">
              <h2 id="my-certificates" tabIndex={-1}>
                My certificates
              </h2>
            </div>
            <div className="panel">
              {data.certificates.length ? (
                data.certificates.map((c: Row) => (
                  <div className="certificate-row" key={c.id}>
                    <Award size={25} />
                    <div>
                      <h3>{c.snapshot.program}</h3>
                      <small>
                        {c.serial} · {c.snapshot.credits} credits
                      </small>
                    </div>
                    <Status value={c.revoked_at ? 'revoked' : 'verified'} />
                    {!c.revoked_at && (
                      <a
                        className="button secondary"
                        href={`/api/public/${t.slug}/certificate/${c.verification_code}.pdf`}
                      >
                        <Download size={15} />
                        Download
                      </a>
                    )}
                  </div>
                ))
              ) : (
                <Empty
                  title="Every achievement belongs here."
                  description="Your certificates appear after completing the learning and verification requirements."
                />
              )}
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </main>
      {assignSeat && (
        <Modal
          title="Assign a group seat"
          subtitle={assignSeat.title}
          onClose={() => setAssignSeat(null)}
        >
          <Form
            label="Assign learner"
            onSubmit={async (d) => {
              await api('/learner/seats/' + assignSeat.id + '/assign', 'POST', {
                name: d.get('name'),
                mobile: d.get('mobile'),
                email: d.get('email'),
              });
              setAssignSeat(null);
              await load();
            }}
          >
            <Field label="Full name">
              <input name="name" required />
            </Field>
            <Field label="Mobile with country code">
              <input name="mobile" type="tel" required />
            </Field>
            <Field label="Email">
              <input name="email" type="email" required />
            </Field>
            <p className="muted">
              Your colleague can sign in using this mobile number to access their enrollment and
              complete their professional profile.
            </p>
          </Form>
        </Modal>
      )}
      {feedback && (
        <Modal
          title="How was your workshop?"
          subtitle={feedback.title}
          onClose={() => setFeedback(null)}
        >
          <Form
            label="Submit feedback"
            onSubmit={async (d) => {
              await api('/learner/enrollments/' + feedback.id + '/feedback', 'POST', {
                rating: Number(d.get('rating')),
                comment: d.get('comment'),
              });
              setFeedback(null);
              await load();
            }}
          >
            <Field label="Overall experience">
              <select name="rating">
                <option value="5">5 — Excellent</option>
                <option value="4">4 — Very good</option>
                <option value="3">3 — Good</option>
                <option value="2">2 — Could be better</option>
                <option value="1">1 — Poor</option>
              </select>
            </Field>
            <Field label="Your feedback">
              <textarea name="comment" rows={4} required />
            </Field>
          </Form>
        </Modal>
      )}
    </div>
  );
}
function CoursePlayer({
  enrollment,
  tenant,
  onBack,
}: {
  enrollment: Row;
  tenant: Row;
  onBack: () => void;
}) {
  const [data, setData] = useState<Row | null>(null),
    [lessonId, setLessonId] = useState(''),
    [error, setError] = useState(''),
    [end, setEnd] = useState(false),
    [quiz, setQuiz] = useState(false),
    [videoUrl, setVideoUrl] = useState('');
  const video = useRef<HTMLVideoElement>(null),
    lastSent = useRef(0);
  const lessonHeading = useRef<HTMLHeadingElement>(null);
  const [curriculumOpen, setCurriculumOpen] = useState(false);
  const chooseLesson = (id: string) => {
    setLessonId(id);
    setQuiz(false);
    setCurriculumOpen(false);
    requestAnimationFrame(() => lessonHeading.current?.focus());
  };
  const readingSaves = useRef<Promise<void>>(Promise.resolve());
  const saveReadingPosition = (current: Row, position: number) => {
    setData(
      (previous) =>
        previous && {
          ...previous,
          lessons: previous.lessons.map((l: Row) =>
            l.id === current.id && l.revision === current.revision
              ? { ...l, last_position: position }
              : l,
          ),
        },
    );
    readingSaves.current = readingSaves.current
      .then(async () => {
        await api(`/learner/courses/${enrollment.id}/progress`, 'POST', {
          lessonId: current.id,
          revision: current.revision,
          position,
        });
      })
      .catch((e) => setError((e as Error).message));
  };
  const load = () =>
    api('/learner/courses/' + enrollment.id)
      .then((d) => {
        setData(d);
        setLessonId((id) =>
          d.lessons.some((l: Row) => l.id === id)
            ? id
            : [...d.lessons]
                .filter((l: Row) => l.checkpoint_at && !l.completed_at)
                .sort(
                  (a: Row, b: Row) =>
                    new Date(b.checkpoint_at).getTime() - new Date(a.checkpoint_at).getTime(),
                )[0]?.id ||
              d.lessons.find((l: Row) => !l.completed_at)?.id ||
              d.lessons[0]?.id ||
              '',
        );
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [enrollment.id]);
  const lesson = data?.lessons.find((l: Row) => l.id === lessonId);
  useEffect(() => {
    setEnd(false);
    setError('');
    lastSent.current = 0;
    setVideoUrl('');
    if (lesson?.kind === 'video')
      api('/learner/courses/' + enrollment.id + '/video/' + lessonId)
        .then((d) => setVideoUrl(d.url))
        .catch((e) => setError(e.message));
  }, [lessonId, lesson?.kind, lesson?.revision]);
  useEffect(() => {
    let hls: any;
    let cancelled = false;
    const element = video.current;
    if (element && videoUrl) {
      if (element.canPlayType('application/vnd.apple.mpegurl')) element.src = videoUrl;
      else
        import('hls.js').then(({ default: Hls }) => {
          if (cancelled) return;
          if (Hls.isSupported()) {
            hls = new Hls();
            hls.loadSource(videoUrl);
            hls.attachMedia(element);
          } else
            setError('This browser cannot play the course video. Please use a current browser.');
        });
    }
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [videoUrl]);
  if (!data)
    return (
      <>
        <button className="text-button" onClick={onBack}>
          ← My learning
        </button>
        <p className={error ? 'error' : 'muted'}>{error || 'Opening your course…'}</p>
      </>
    );
  const completed = data.lessons.filter((l: Row) => l.completed_at).length;
  const nextLesson = data.lessons[data.lessons.findIndex((l: Row) => l.id === lessonId) + 1];
  const required = data.lessons.filter((l: Row) => l.required);
  const pendingRequired = required.find((l: Row) => !l.completed_at);
  const modules: { title: string; lessons: Row[] }[] = [];
  for (const item of data.lessons as Row[]) {
    if (modules.at(-1)?.title !== item.module_title)
      modules.push({ title: item.module_title, lessons: [] });
    modules.at(-1)!.lessons.push(item);
  }
  return (
    <>
      <button className="text-button back-link" onClick={onBack}>
        ← My learning
      </button>
      <PageHeading
        title={enrollment.title}
        subtitle={`${completed} of ${data.lessons.length} lessons complete · ${required.filter((l: Row) => l.completed_at).length} of ${required.length} required · ${enrollment.credits} credits`}
      />
      <div className="player-layout">
        <aside className="panel lesson-nav">
          <h3>Your curriculum</h3>
          <div className="progress-track">
            <i
              style={{
                width: (data.lessons.length ? (completed / data.lessons.length) * 100 : 0) + '%',
              }}
            />
          </div>
          <button
            className="curriculum-toggle"
            aria-expanded={curriculumOpen}
            aria-controls="course-curriculum"
            onClick={() => setCurriculumOpen(!curriculumOpen)}
          >
            {curriculumOpen ? 'Hide curriculum' : 'Browse curriculum'} · {data.lessons.length}{' '}
            lessons
          </button>
          <div
            id="course-curriculum"
            className={'curriculum-list' + (curriculumOpen ? ' is-open' : '')}
          >
            {modules.map((module, moduleIndex) => (
              <section className="curriculum-module" key={moduleIndex} aria-label={module.title}>
                <h4>
                  {module.title}
                  <span>
                    {module.lessons.filter((l: Row) => l.completed_at).length}/
                    {module.lessons.length}
                  </span>
                </h4>
                {module.lessons.map((l: Row) => (
                  <button
                    className={lessonId === l.id && !quiz ? 'active' : ''}
                    aria-current={lessonId === l.id && !quiz ? 'step' : undefined}
                    key={l.id}
                    onClick={() => {
                      chooseLesson(l.id);
                    }}
                  >
                    <span className={'lesson-indicator ' + (l.completed_at ? 'done' : '')}>
                      {l.completed_at ? (
                        <Check size={12} aria-label="Completed" />
                      ) : (
                        data.lessons.indexOf(l) + 1
                      )}
                    </span>
                    <span>
                      {l.title}
                      {!l.required && <span className="lesson-optional">Optional</span>}
                    </span>
                  </button>
                ))}
              </section>
            ))}
            <button
              onClick={() => {
                setQuiz(true);
                setCurriculumOpen(false);
              }}
              className={quiz ? 'active' : ''}
              aria-current={quiz ? 'step' : undefined}
            >
              <Award size={19} />
              Post-test
            </button>
          </div>
        </aside>
        <section className="panel lesson-content">
          {quiz ? (
            <LearnerPostTest
              enrollmentId={enrollment.id}
              data={data}
              tenant={tenant}
              reload={load}
              reviewLesson={chooseLesson}
            />
          ) : lesson ? (
            <>
              <div className="eyebrow">{lesson.module_title}</div>
              <h2 ref={lessonHeading} tabIndex={-1}>
                {lesson.title}
              </h2>
              {lesson.kind === 'video' ? (
                <>
                  <video
                    ref={video}
                    controls
                    playsInline
                    onLoadedMetadata={(e) => {
                      e.currentTarget.currentTime = Math.min(
                        lesson.last_position || 0,
                        e.currentTarget.duration || 0,
                      );
                    }}
                    onError={() =>
                      setError('Video playback failed. Refresh the course and try again.')
                    }
                    className="video-player"
                    onTimeUpdate={async (e) => {
                      if (Date.now() - lastSent.current < 15000) return;
                      lastSent.current = Date.now();
                      try {
                        await api('/learner/courses/' + enrollment.id + '/progress', 'POST', {
                          lessonId,
                          revision: lesson.revision,
                          position: Math.floor(e.currentTarget.currentTime),
                        });
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                  />
                  <p className="muted">
                    Progress is saved while you watch. A video completes at 90% watched.
                  </p>
                </>
              ) : lesson.kind === 'pdf' ? (
                <Suspense fallback={<p>Opening document…</p>}>
                  <PdfReader
                    key={lesson.id + ':' + lesson.revision}
                    title={lesson.title}
                    url={`/api/learner/courses/${enrollment.id}/document/${lesson.id}`}
                    initialPage={lesson.last_position || 1}
                    onEnd={() => setEnd(true)}
                    onPosition={(position) => saveReadingPosition(lesson, position)}
                  />
                </Suspense>
              ) : (
                <TextLessonReader
                  key={lesson.id + ':' + lesson.revision}
                  lesson={lesson}
                  onEnd={() => setEnd(true)}
                  onPosition={(position) => saveReadingPosition(lesson, position)}
                />
              )}
              <div className="lesson-bottom">
                {lesson.completed_at ? (
                  <>
                    <Badge tone="positive">Completed</Badge>
                    <Button
                      onClick={() =>
                        nextLesson
                          ? chooseLesson(nextLesson.id)
                          : pendingRequired
                            ? chooseLesson(pendingRequired.id)
                            : data.quiz
                              ? setQuiz(true)
                              : onBack()
                      }
                    >
                      {nextLesson
                        ? 'Next lesson'
                        : pendingRequired
                          ? 'Continue required lessons'
                          : data.quiz
                            ? 'Go to post-test'
                            : 'Back to my learning'}{' '}
                      <ArrowRight size={15} />
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={lesson.kind === 'video' || !end}
                    onClick={async () => {
                      try {
                        await readingSaves.current;
                        await api('/learner/courses/' + enrollment.id + '/progress', 'POST', {
                          lessonId,
                          revision: lesson.revision,
                          completed: true,
                        });
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Mark lesson complete <Check size={15} />
                  </Button>
                )}
                {!lesson.completed_at && !end && ['text', 'pdf'].includes(lesson.kind) && (
                  <small>Read to the end to complete this lesson.</small>
                )}
              </div>
            </>
          ) : (
            <Empty
              title="Your curriculum is being prepared."
              description="The academy will add lessons here."
            />
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    </>
  );
}
export function VerifyCertificate({ slug, code }: { slug: string; code: string }) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api('/public/' + slug + '/verify/' + code)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [slug, code]);
  return (
    <div className="verification-page">
      <PortalHeader name="Certificate verification" />
      <main className="verification-card panel">
        {error ? (
          <>
            <ShieldCheck size={48} />
            <h1>Certificate not found.</h1>
            <p>{error}</p>
          </>
        ) : data ? (
          <>
            <div className={'verification-seal ' + (data.revoked_at ? 'revoked' : '')}>
              <Award size={42} />
            </div>
            <Status value={data.revoked_at ? 'revoked' : 'verified'} />
            <h1>{data.revoked_at ? 'Certificate revoked.' : 'An achievement, verified.'}</h1>
            {data.snapshot.sample && (
              <div className="notice">Sample certificate. Not valid for professional credit.</div>
            )}
            <p>This certifies that</p>
            <h2>{data.snapshot.name}</h2>
            <p>
              completed <strong>{data.snapshot.program}</strong>
              <br />
              with {data.snapshot.academy}.
            </p>
            <div className="detail-summary">
              <div>
                <small>Credits</small>
                <strong>
                  {data.snapshot.credits} {data.snapshot.creditType}
                </strong>
              </div>
              <div>
                <small>Issued</small>
                <strong>{date(data.issued_at)}</strong>
              </div>
            </div>
            <p className="mono">{data.serial}</p>
            {!data.revoked_at && (
              <a className="button secondary" href={`/api/public/${slug}/certificate/${code}.pdf`}>
                <Download size={16} />
                Download certificate
              </a>
            )}
          </>
        ) : (
          <p>Verifying certificate…</p>
        )}
      </main>
    </div>
  );
}
