import { CoursePublication } from './CoursePublication';
import { advancedFinanceEnabled } from './product-features';
import { CatalogDetailsEditor, catalogDetailsFromForm } from './CatalogDetailsEditor';
import { CancellationQueue } from './Cancellations';
import { CancellationPolicySettings } from './CancellationPolicy';
import { RefundQueue } from './Refunds';
import { BillingSettings, BillingQueue } from './Billing';
import { OfflinePaymentQueue } from './OfflinePayments';
import { ReconciliationQueue } from './Reconciliation';
import { ProgramActions, OfferingActions, CouponManager } from './CatalogEditors';
import { QuizHistory, RetakeQueue } from './AssessmentHistory';
import React, { useEffect, useState } from 'react';
import { WebsiteIntegration } from './WebsiteIntegration';
import { TeamSettings, FacultyAssignment } from './TeamSettings';
import { LessonPreview } from './LessonPreview';
import { CourseCurriculum } from './CourseCurriculum';
import { CourseLearners } from './CourseLearners';
import { CourseAccess, WorkshopCourses } from './CourseAccess';
import { PaymentModal, PaymentPolicy } from './PaymentDetails';
import {
  LayoutDashboard,
  LibraryBig,
  CalendarDays,
  MonitorPlay,
  Inbox,
  UsersRound,
  CreditCard,
  Award,
  Settings2,
  Search,
  Plus,
  ArrowUpRight,
  ArrowRight,
  ChevronDown,
  LogOut,
  Check,
  ShieldCheck,
  Clock3,
  MapPin,
  BookOpen,
  Menu,
  X,
  Download,
  CircleHelp,
  Activity,
} from 'lucide-react';
import {
  api,
  type Row,
  money,
  date,
  initials,
  Badge,
  Button,
  Field,
  Modal,
  Form,
  Empty,
  PageHeading,
  LinkButton,
  Status,
  ExternalLink,
} from './shared';
import { Checkout, LearnerPortal, VerifyCertificate } from './Portal';
const nav = [
  ['overview', 'Overview', LayoutDashboard],
  ['programs', 'Programs', LibraryBig],
  ['workshops', 'Workshops', CalendarDays],
  ['courses', 'Online courses', MonitorPlay],
  ['leads', 'Lead inbox', Inbox],
  ['learners', 'Learners', UsersRound],
  ['orders', 'Orders & payments', CreditCard],
  ['certificates', 'Certificates', Award],
  ['settings', 'Academy settings', Settings2],
] as const;
export function Login({
  onLogin,
  slug: initialSlug = 'icode',
  learner = false,
}: {
  onLogin: () => void;
  slug?: string;
  learner?: boolean;
}) {
  const [slug, setSlug] = useState(initialSlug),
    [demoRole, setDemoRole] = useState(learner ? 'learner' : 'admin'),
    [identifier, setIdentifier] = useState(''),
    [challenge, setChallenge] = useState<Row | null>(null),
    [bootstrap, setBootstrap] = useState<Row | null>(null);
  useEffect(() => {
    api('/bootstrap')
      .then((data) => {
        setBootstrap(data);
        if (data.development && !learner) setIdentifier('admin@example.com');
      })
      .catch(() => {});
  }, []);
  return (
    <div className="login-layout">
      <div className="login-story">
        <div className="brand">
          <div className="brand-icon">
            a<span>·</span>
          </div>
          <span>
            academy<span className="brand-os">OS</span>
          </span>
        </div>
        <div>
          <div className="eyebrow">THE BUSINESS OF BETTER LEARNING</div>
          <h1>
            Great education.
            <br />
            Beautifully run.
          </h1>
          <p>
            From the first booking to the final certificate.
            <br />
            One connected home for your academy.
          </p>
          <div className="story-art">
            <div className="orbit o1" />
            <div className="orbit o2" />
            <div className="orbit o3" />
            <div className="art-card">
              <ShieldCheck />
              <span>Every detail, connected.</span>
            </div>
          </div>
        </div>
        <span className="story-footer">Built for the way dental academies work.</span>
      </div>
      <div className="login-form">
        <div className="eyebrow">
          {learner ? 'YOUR LEARNING JOURNEY' : 'YOUR ACADEMY WORKSPACE'}
        </div>
        <h2>
          {bootstrap?.demo
            ? 'Explore your academy.'
            : challenge
              ? 'Check your messages.'
              : 'Welcome back.'}
        </h2>
        <p className="muted">
          {bootstrap?.demo
            ? 'Choose an academy and role. Enter the access code shared by your host.'
            : challenge
              ? 'Enter your six-digit code to continue.'
              : 'Sign in securely. No password to remember.'}
        </p>
        {bootstrap?.demo ? (
          <Form
            label="Open demo"
            onSubmit={async (d) => {
              await api('/auth/demo', 'POST', {
                slug,
                role: demoRole,
                code: String(d.get('demoCode')),
              });
              onLogin();
            }}
          >
            <Field label="Academy">
              <select value={slug} onChange={(e) => setSlug(e.target.value)}>
                {bootstrap.academies.map((a: Row) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Explore as">
              <select value={demoRole} onChange={(e) => setDemoRole(e.target.value)}>
                <option value="admin">Academy administrator</option>
                <option value="coordinator">Coordinator</option>
                <option value="marketing">Marketing</option>
                <option value="faculty">Faculty</option>
                <option value="learner">Learner</option>
              </select>
            </Field>
            <Field label="Demo access code">
              <input name="demoCode" type="password" autoComplete="current-password" required />
            </Field>
            <div className="notice">
              Shared demonstration workspace. Changes are saved and visible to other reviewers.
              Payments and message delivery are disconnected.
            </div>
          </Form>
        ) : !challenge ? (
          <Form
            label="Send sign-in code"
            onSubmit={async () =>
              setChallenge(
                await api('/auth/request', 'POST', {
                  slug,
                  kind: learner ? 'learner' : 'staff',
                  identifier,
                }),
              )
            }
          >
            <Field label="Academy">
              {bootstrap?.academies?.length ? (
                <select value={slug} onChange={(e) => setSlug(e.target.value)}>
                  {bootstrap.academies.map((a: Row) => (
                    <option key={a.slug} value={a.slug}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
              )}
            </Field>
            <Field
              label={learner ? 'Mobile number' : 'Work email'}
              hint={learner ? 'Include your country code, e.g. +919876543210' : undefined}
            >
              <input
                type={learner ? 'tel' : 'email'}
                value={identifier}
                placeholder={learner ? '+91 98765 43210' : 'you@academy.com'}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoComplete={learner ? 'tel' : 'email'}
              />
            </Field>
          </Form>
        ) : (
          <Form
            label="Sign in"
            onSubmit={async (d) => {
              await api('/auth/verify', 'POST', {
                slug,
                challengeId: challenge.challengeId,
                code: String(d.get('code')),
              });
              onLogin();
            }}
          >
            <Field label="Verification code">
              <input
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="000000"
                defaultValue={challenge.developmentCode || ''}
                required
                autoFocus
              />
            </Field>
            {challenge.developmentCode && (
              <div className="notice">
                Local development code: <strong>{challenge.developmentCode}</strong>. Live delivery
                is not configured.
              </div>
            )}
            <button className="text-button" type="button" onClick={() => setChallenge(null)}>
              Use another account
            </button>
          </Form>
        )}
        {bootstrap?.development && (
          <div className="login-note">
            <Badge tone="amber">Development environment</Badge>
            <p>
              Sample academy data.{' '}
              {learner
                ? 'Use a sample learner’s mobile number to inspect existing enrollments.'
                : 'Use admin@example.com for either sample academy.'}{' '}
              No live payments.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
export default function App() {
  const path = location.pathname.split('/').filter(Boolean),
    [identity, setIdentity] = useState<Row | null | undefined>(undefined),
    [error, setError] = useState('');
  const load = () =>
    api('/me')
      .then(setIdentity)
      .catch(() => setIdentity(null));
  useEffect(() => {
    load();
  }, []);
  if (path[0] === 'verify') return <VerifyCertificate slug={path[1]} code={path[2]} />;
  if (path[0] === 'book')
    return (
      <Checkout slug={path[1]} offeringSlug={path[2]} identity={identity} reloadIdentity={load} />
    );
  if (identity === undefined) return <div className="loading">Opening your workspace…</div>;
  if (!identity)
    return <Login onLogin={load} slug={path[1] || 'icode'} learner={path[0] === 'learn'} />;
  const logout = async () => {
    await api('/auth/logout', 'POST');
    setIdentity(null);
  };
  if (identity.role === 'learner') return <LearnerPortal identity={identity} logout={logout} />;
  return <Workspace identity={identity} logout={logout} />;
}
function Workspace({ identity, logout }: { identity: Row; logout: () => void }) {
  const [data, setData] = useState<Row | null>(null),
    [page, setPage] = useState('overview'),
    [search, setSearch] = useState(''),
    [modal, setModal] = useState<string | null>(null),
    [selected, setSelected] = useState<Row | null>(null),
    [toast, setToast] = useState(''),
    [failure, setFailure] = useState(''),
    [menu, setMenu] = useState(false),
    [selectedProgram, setSelectedProgram] = useState('');
  const [paymentOrder, setPaymentOrder] = useState<Row | null>(null);
  const [importingCourse, setImportingCourse] = useState(false);
  const reload = () =>
    api('/workspace')
      .then(setData)
      .catch((e) => setFailure(e.message));
  useEffect(() => {
    reload();
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const navigate = (p: string) => {
    setPage(p);
    setSelected(null);
    setSearch('');
    setMenu(false);
  };
  const done = async (message: string) => {
    setModal(null);
    setSelectedProgram('');
    await reload();
    setToast(message);
  };
  const act = async (path: string, method: string, body: any, message: string) => {
    try {
      await api(path, method, body);
      await reload();
      setToast(message);
    } catch (e) {
      setFailure((e as Error).message);
    }
  };
  if (!data) return <div className="loading">{failure || 'Preparing your academy…'}</div>;
  const t = data.tenant,
    workshops = data.offerings.filter((o: Row) => o.kind === 'workshop'),
    courses = data.offerings.filter((o: Row) => o.kind === 'course'),
    pending = data.contacts.filter((c: Row) => c.license_status === 'pending');
  const matches = (item: Row) => JSON.stringify(item).toLowerCase().includes(search.toLowerCase());
  const access = data.capabilities;
  const canEdit = access.editCatalog;
  const visiblePages = [
    'overview',
    'programs',
    'workshops',
    'courses',
    ...(access.viewLeads ? ['leads'] : []),
    ...(access.reviewLicenses ? ['learners'] : []),
    ...(access.viewOrders ? ['orders'] : []),
    ...(access.issueCertificates ? ['certificates'] : []),
    ...(access.manageSettings ? ['settings'] : []),
  ];
  const createOffering = (kind: string, program = '') => {
    setSelectedProgram(program);
    setModal(kind);
  };
  return (
    <div className="app-shell">
      <aside className={'sidebar ' + (menu ? 'mobile-open' : '')}>
        <div className="brand">
          <div className="brand-icon">
            a<span>·</span>
          </div>
          <span>
            academy<span className="brand-os">OS</span>
          </span>
          <button
            className="icon-button mobile-only"
            onClick={() => setMenu(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <button className="academy-switch" onClick={() => setModal('switch')}>
          <div className="academy-avatar">{t.slug === 'icode' ? 'ic' : 'S'}</div>
          <span>
            <strong>{t.name}</strong>
            <small>Academy workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav
            .filter(([id]) => visiblePages.includes(id))
            .map(([id, label, Icon]) => (
              <button key={id} className={page === id ? 'active' : ''} onClick={() => navigate(id)}>
                <Icon size={18} />
                <span>{label}</span>
                {id === 'leads' && data.leads.length > 0 && (
                  <b>{data.leads.filter((l: Row) => !['won', 'lost'].includes(l.stage)).length}</b>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <div className="leaf-mark">✧</div>
            <strong>Made for the whole journey.</strong>
            <p>
              A little less admin.
              <br />A lot more education.
            </p>
          </div>
          <button className="profile" onClick={logout} title="Sign out">
            <div className="avatar">{initials(identity.name)}</div>
            <span>
              <strong>{identity.name}</strong>
              <small>{identity.role === 'admin' ? 'Academy admin' : identity.role}</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              onClick={() => setMenu(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{nav.find((n) => n[0] === page)?.[1]}</strong>
          </div>
          <div className="topbar-right">
            <div className="search">
              <Search size={16} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search this view…"
                aria-label="Search this view"
              />
              <kbd>⌕</kbd>
            </div>
            <button
              className="icon-button"
              onClick={() => setModal('help')}
              aria-label="Workspace help"
            >
              <CircleHelp size={19} />
            </button>
            <div className="avatar small">{initials(identity.name)}</div>
          </div>
        </header>
        {(data.development || data.demo) && (
          <div className="environment-strip">
            <span className="status-dot" />
            {data.demo ? 'Demo workspace' : 'Development workspace'} <span>·</span> Sample data{' '}
            <span>·</span> Live services are not connected
          </div>
        )}
        <main className="main-content">
          {page === 'overview' && (
            <>
              <PageHeading
                eyebrow={new Intl.DateTimeFormat(t.locale, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  timeZone: t.timezone,
                })
                  .format(new Date())
                  .toUpperCase()}
                title={
                  access.teachingOnly ? 'Your teaching schedule.' : 'A clear view of your academy.'
                }
                subtitle={
                  access.teachingOnly
                    ? 'Your assigned workshops, learners and course curriculum.'
                    : 'Your programs, people and priorities. All in one place.'
                }
                action={
                  canEdit ? (
                    <Button onClick={() => createOffering('workshop')}>
                      <Plus size={16} />
                      Create workshop
                    </Button>
                  ) : undefined
                }
              />
              <div className={access.viewRevenue ? 'metrics' : 'metrics three'}>
                {access.viewRevenue && (
                  <Metric
                    label="Paid"
                    value={money(data.summary.collected, t, true)}
                    foot="Money allocated to bookings"
                    icon={<CreditCard size={17} />}
                  />
                )}
                <Metric
                  label="Upcoming workshops"
                  value={String(
                    workshops.filter(
                      (o: Row) => o.status === 'open' && new Date(o.starts_at) > new Date(),
                    ).length,
                  ).padStart(2, '0')}
                  foot="Open for enrollment"
                  icon={<CalendarDays size={17} />}
                />
                <Metric
                  label="Workshop enrollments"
                  value={String(workshops.reduce((sum: number, o: Row) => sum + o.enrolled, 0))}
                  foot="Confirmed seats across runs"
                  icon={<UsersRound size={17} />}
                />
                {access.viewRevenue && (
                  <Metric
                    label="Outstanding balances"
                    value={money(data.summary.outstanding, t, true)}
                    foot="Deposits awaiting settlement"
                    icon={<Clock3 size={17} />}
                    amber
                  />
                )}
                {!access.viewRevenue && (
                  <Metric
                    label="Online courses"
                    value={String(courses.length)}
                    foot={access.teachingOnly ? 'Assigned to you' : 'In the academy catalog'}
                    icon={<MonitorPlay size={17} />}
                  />
                )}
              </div>
              {access.teachingOnly && !data.offerings.length && (
                <Empty
                  title="No teaching assignments yet"
                  description="Ask an academy admin or coordinator to assign you to a workshop or course. Your teaching and learners will appear here."
                />
              )}
              {access.viewRunRevenue && (
                <section className="panel table-wrap">
                  <div className="panel-title">
                    <div>
                      <h2>Revenue by offering</h2>
                      <p>Recorded payments and refunds for each workshop or course.</p>
                    </div>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Offering</th>
                        <th>Orders</th>
                        <th>Applied payments</th>
                        <th>Booking refunds</th>
                        <th>Excess returned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.runRevenue.filter(matches).map((r: Row) => (
                        <tr key={r.id}>
                          <td>{r.title}</td>
                          <td>{r.orders}</td>
                          <td>{money(r.collected, t)}</td>
                          <td>{money(r.refunded, t)}</td>
                          <td>{money(r.excess_returned, t)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              <div className="section-heading">
                <div>
                  <h2>Coming up at your academy</h2>
                  <p>Keep every workshop on track.</p>
                </div>
                <LinkButton onClick={() => navigate('workshops')}>View all workshops</LinkButton>
              </div>
              <div className="workshop-grid">
                {workshops
                  .filter(matches)
                  .slice(0, 3)
                  .map((o: Row, n: number) => (
                    <WorkshopCard
                      key={o.id}
                      o={o}
                      tenant={t}
                      index={n}
                      onOpen={() => {
                        navigate('workshops');
                        setSelected(o);
                      }}
                    />
                  ))}
              </div>
              <div className="dashboard-bottom">
                {!access.teachingOnly && (
                  <section className="panel">
                    <div className="panel-title">
                      <div>
                        <h2>Your attention, please</h2>
                        <p>A few things to move forward today.</p>
                      </div>
                      <span className="count-label">
                        {pending.length + data.leads.filter((l: Row) => l.stage === 'new').length}{' '}
                        open
                      </span>
                    </div>
                    {access.reviewLicenses && (
                      <Priority
                        icon={<ShieldCheck size={19} />}
                        title="Licenses ready for review"
                        subtitle="Verify credentials to keep certificates on track."
                        count={pending.length}
                        onClick={() => navigate('learners')}
                      />
                    )}
                    {access.viewLeads && (
                      <Priority
                        icon={<Inbox size={19} />}
                        title="New conversations to follow up"
                        subtitle="A personal touch can make the difference."
                        count={data.leads.filter((l: Row) => l.stage === 'new').length}
                        onClick={() => navigate('leads')}
                      />
                    )}
                    <Priority
                      icon={<CreditCard size={19} />}
                      title="Balance payments outstanding"
                      subtitle="Review deposits before workshop cutoffs."
                      count={data.orders.filter((o: Row) => o.status === 'partial').length}
                      onClick={() => navigate('orders')}
                    />
                  </section>
                )}
                <section className="panel learning-panel">
                  <span className="eyebrow">LEARNING, BEYOND THE WORKSHOP</span>
                  <div className="learning-illustration">
                    <BookOpen size={64} strokeWidth={1} />
                    <div className="little-star">✦</div>
                    <div className="little-circle" />
                  </div>
                  <h2>
                    Let their next chapter
                    <br />
                    start anywhere.
                  </h2>
                  <p>
                    {courses.length} self-paced course{courses.length !== 1 ? 's' : ''} in your
                    catalog.
                    <br />
                    Build, teach and track in one place.
                  </p>
                  <LinkButton onClick={() => navigate('courses')}>
                    {canEdit ? 'Manage online courses' : 'View online courses'}
                  </LinkButton>
                </section>
              </div>
            </>
          )}
          {page === 'programs' && (
            <>
              <PageHeading
                title="The foundation of your teaching."
                subtitle="Create a program once. Run it as many times as you need."
                action={
                  canEdit ? (
                    <div className="inline-actions">
                      <CouponManager
                        programs={data.programs}
                        offerings={data.offerings}
                        tenant={t}
                      />
                      <Button onClick={() => setModal('program')}>
                        <Plus size={16} />
                        New program
                      </Button>
                    </div>
                  ) : undefined
                }
              />
              <div className="program-grid">
                {data.programs.filter(matches).map((p: Row, n: number) => (
                  <section className="panel program-card" key={p.id}>
                    <div className={'program-symbol tone-' + (n % 4)}>
                      <LibraryBig size={26} />
                    </div>
                    <Badge>{p.specialty}</Badge>
                    <Status
                      value={p.archived_at ? 'archived' : p.published ? 'published' : 'draft'}
                    />
                    <h2>{p.title}</h2>
                    <p>{p.description}</p>
                    <div className="program-meta">
                      <span>
                        {p.credits} {p.credit_type} credits
                      </span>
                      <span>
                        {data.offerings.filter((o: Row) => o.program_id === p.id).length} offerings
                      </span>
                    </div>
                    <div className="faculty-line">
                      <div className="avatar small">
                        {initials(p.faculty[0]?.name || 'Faculty')}
                      </div>
                      <span>{p.faculty[0]?.name || 'Faculty to be assigned'}</span>
                    </div>
                    {canEdit && (
                      <div className="inline-actions">
                        <ProgramActions program={p} onSaved={done} />
                        {!p.archived_at && (
                          <Button secondary onClick={() => createOffering('workshop', p.id)}>
                            Schedule a workshop <ArrowUpRight size={15} />
                          </Button>
                        )}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </>
          )}
          {page === 'workshops' &&
            (selected ? (
              <RunDetail
                o={data.offerings.find((o: Row) => o.id === selected.id) || selected}
                tenant={t}
                onBack={() => setSelected(null)}
                notify={setToast}
                access={access}
                reload={reload}
              />
            ) : (
              <>
                <PageHeading
                  title="Every run, thoughtfully managed."
                  subtitle="From opening seats to welcoming your next cohort."
                  action={
                    canEdit ? (
                      <Button onClick={() => createOffering('workshop')}>
                        <Plus size={16} />
                        Create workshop
                      </Button>
                    ) : undefined
                  }
                />
                <div className="tabline">
                  <span className="selected">
                    All workshops <b>{workshops.length}</b>
                  </span>
                  <span>
                    {workshops.filter((o: Row) => o.status === 'open').length} open for booking
                  </span>
                </div>
                <div className="panel table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Workshop</th>
                        <th>Dates & location</th>
                        <th>Enrollment</th>
                        {!access.teachingOnly && <th>Price</th>}
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {workshops.filter(matches).map((o: Row) => (
                        <tr key={o.id}>
                          <td>
                            <button className="table-title" onClick={() => setSelected(o)}>
                              {o.title}
                            </button>
                            <small>{o.specialty}</small>
                          </td>
                          <td>
                            {date(o.starts_at, t)} – {date(o.ends_at, t)}
                            <small>{o.venue}</small>
                          </td>
                          <td>
                            <span>
                              {o.enrolled} / {o.capacity} seats
                            </span>
                            <div className="progress-track">
                              <i style={{ width: `${(o.enrolled / o.capacity) * 100}%` }} />
                            </div>
                          </td>
                          {!access.teachingOnly && <td>{money(o.tickets[0]?.price || 0, t)}</td>}
                          <td>
                            <Status value={o.archived_at ? 'archived' : o.status} />
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={'Open ' + o.title}
                              onClick={() => setSelected(o)}
                            >
                              <ArrowUpRight size={17} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ))}
          {page === 'courses' &&
            (selected ? (
              <CourseBuilder
                reload={reload}
                o={data.offerings.find((o: Row) => o.id === selected.id) || selected}
                tenant={t}
                onBack={() => setSelected(null)}
                notify={setToast}
                access={access}
              />
            ) : (
              <>
                <PageHeading
                  title="Learning without limits."
                  subtitle="Self-paced courses, purposeful progress and verified completion."
                  action={
                    canEdit ? (
                      <Button onClick={() => createOffering('course')}>
                        <Plus size={16} />
                        Create course
                      </Button>
                    ) : undefined
                  }
                />
                {access.editCatalog && <RetakeQueue tenant={t} />}
                {canEdit && (
                  <section className="panel course-template-card">
                    <BookOpen size={28} />
                    <div>
                      <div className="eyebrow">A COMPLETE COURSE TO MAKE YOUR OWN</div>
                      <h2>Clinical Photography Foundations</h2>
                      <p>
                        6 modules · 12 practical lessons · downloadable workbook · 16-question
                        assessment.
                      </p>
                      <p className="muted">
                        Creates an editable draft for academy review. Set your faculty, price and
                        approved credits before publishing. Opening it again keeps your edits.
                      </p>
                    </div>
                    <Button
                      secondary
                      disabled={importingCourse}
                      onClick={async () => {
                        setImportingCourse(true);
                        try {
                          const result = await api(
                            '/courses/templates/clinical-photography',
                            'POST',
                            {},
                          );
                          const workspace = await api('/workspace');
                          setData(workspace);
                          setSelected(
                            workspace.offerings.find((course: Row) => course.id === result.id),
                          );
                          setToast(
                            result.created
                              ? 'Complete course added. Review every lesson before publishing.'
                              : 'Your complete course is ready to edit.',
                          );
                        } catch (error) {
                          setFailure((error as Error).message);
                        } finally {
                          setImportingCourse(false);
                        }
                      }}
                    >
                      {importingCourse ? 'Preparing course…' : 'Open complete course'}
                    </Button>
                  </section>
                )}
                <div className="program-grid">
                  {courses.filter(matches).map((o: Row, n: number) => (
                    <section className="panel course-card" key={o.id}>
                      <div className={'course-cover tone-' + (n % 4)}>
                        <MonitorPlay size={54} strokeWidth={1} />
                        <Badge>SELF-PACED</Badge>
                      </div>
                      <div className="course-body">
                        <Status value={o.archived_at ? 'archived' : o.status} />
                        <h2>{o.title}</h2>
                        <p>
                          {o.credits} {o.credit_type} credits ·{' '}
                          {o.access_days ? o.access_days + ' days access' : 'Lifetime access'}
                        </p>
                        <div className="program-meta">
                          {!access.teachingOnly && (
                            <strong>{money(o.tickets[0]?.price || 0, t)}</strong>
                          )}
                          <span>{o.enrolled} enrolled</span>
                        </div>
                        <Button secondary onClick={() => setSelected(o)}>
                          {canEdit ? 'Open course builder' : 'View curriculum'}{' '}
                          <ArrowRight size={15} />
                        </Button>
                      </div>
                    </section>
                  ))}
                </div>
              </>
            ))}
          {page === 'leads' && (
            <>
              <PageHeading
                title="Good conversations become great cohorts."
                subtitle="A shared inbox for inquiries, follow-ups and next steps."
                action={
                  access.manageLeads ? (
                    <Button onClick={() => setModal('lead')}>
                      <Plus size={16} />
                      Add a lead
                    </Button>
                  ) : undefined
                }
              />
              <div className="tabline">
                <span className="selected">
                  All leads <b>{data.leads.length}</b>
                </span>
                <span>
                  {data.leads.filter((l: Row) => l.stage === 'new').length} need a first response
                </span>
              </div>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Contact</th>
                      <th>Interested in</th>
                      <th>Source</th>
                      <th>Stage</th>
                      <th>Added</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.leads.filter(matches).map((l: Row) => (
                      <tr key={l.id}>
                        <td>
                          <div className="person">
                            <div className="avatar">{initials(l.name)}</div>
                            <div>
                              <strong>{l.name}</strong>
                              <small>{l.mobile}</small>
                            </div>
                          </div>
                        </td>
                        <td>{l.offering_title || 'General inquiry'}</td>
                        <td>{l.source}</td>
                        <td>
                          <Status value={l.stage} />
                        </td>
                        <td>{date(l.created_at, t)}</td>
                        <td>
                          <Button
                            secondary
                            onClick={() => {
                              setSelected(l);
                              setModal('lead-edit');
                            }}
                          >
                            Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.leads.length && (
                  <Empty
                    title="Your inbox is clear."
                    description="Add your first inquiry to start the conversation."
                  />
                )}
              </div>
            </>
          )}
          {page === 'learners' && (
            <>
              <PageHeading
                title="The people behind every seat."
                subtitle="Professional profiles, credentials and a connected learning journey."
              />
              <div className="tabline">
                <span className="selected">
                  All learners <b>{data.contacts.length}</b>
                </span>
                <span>{pending.length} licenses awaiting review</span>
              </div>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Learner</th>
                      <th>Clinic</th>
                      <th>Professional registration</th>
                      <th>License</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.contacts.filter(matches).map((c: Row) => (
                      <tr key={c.id}>
                        <td>
                          <div className="person">
                            <div className="avatar">{initials(c.name || '?')}</div>
                            <div>
                              <strong>{c.name || 'Profile incomplete'}</strong>
                              <small>{c.email || c.mobile}</small>
                            </div>
                          </div>
                        </td>
                        <td>{c.clinic || '—'}</td>
                        <td>
                          {c.license_number || 'Not provided'}
                          <small>{c.license_council}</small>
                        </td>
                        <td>
                          <Status value={c.license_status} />
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => {
                              setSelected(c);
                              setModal('license');
                            }}
                          >
                            Review <ArrowUpRight size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {page === 'orders' && (
            <>
              <PageHeading
                title="Every payment, accounted for."
                subtitle="A clear record of bookings, deposits and outstanding balances."
                action={
                  <a className="button secondary" href="/api/orders/export">
                    <Download size={16} />
                    Export orders
                  </a>
                }
              />
              {access.viewRevenue && (
                <div className="metrics">
                  <Metric
                    label="Paid"
                    value={money(data.summary.collected, t, true)}
                    foot="Money allocated to bookings"
                  />
                  {data.summary.unallocated > 0 && (
                    <Metric
                      label="Payment needs review"
                      value={money(data.summary.unallocated, t, true)}
                      foot="Received money awaiting resolution"
                      amber
                    />
                  )}
                  <Metric
                    label="Outstanding"
                    value={money(data.summary.outstanding, t, true)}
                    foot="Remaining on deposit orders"
                    amber
                  />
                  {data.summary.refunded > 0 && (
                    <Metric
                      label="Refunded"
                      value={money(data.summary.refunded, t, true)}
                      foot="Confirmed returns"
                    />
                  )}
                </div>
              )}
              {access.managePayments && (
                <>
                  {advancedFinanceEnabled && (
                    <>
                      <ReconciliationQueue tenant={t} onOpen={setPaymentOrder} revision={data} />
                      <CancellationQueue tenant={t} onOpen={setPaymentOrder} revision={data} />
                      <RefundQueue tenant={t} onOpen={setPaymentOrder} revision={data} />
                    </>
                  )}
                  <OfflinePaymentQueue tenant={t} onOpen={setPaymentOrder} revision={data} />
                  {advancedFinanceEnabled && (
                    <BillingQueue onOpen={setPaymentOrder} revision={data} />
                  )}
                </>
              )}
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Offering</th>
                      <th>Seats</th>
                      <th>Total</th>
                      <th>Paid</th>
                      <th>Balance</th>
                      <th>Status</th>
                      {access.managePayments && <th>Payment details</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.filter(matches).map((o: Row) => (
                      <tr key={o.id}>
                        <td>
                          <strong className="mono">{o.id.slice(0, 8).toUpperCase()}</strong>
                          <small>{date(o.created_at, t)}</small>
                        </td>
                        <td>{o.title}</td>
                        <td>{o.quantity}</td>
                        <td>{money(o.total, t)}</td>
                        <td>{money(o.paid, t)}</td>
                        <td>{money(o.total - o.paid, t)}</td>
                        <td>
                          <Status value={o.archived_at ? 'archived' : o.status} />
                        </td>
                        {access.managePayments && (
                          <td>
                            <Button secondary onClick={() => setPaymentOrder(o)}>
                              Review payment
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {page === 'certificates' && (
            <>
              <PageHeading
                title="Achievement, made official."
                subtitle="Eligibility-checked certificates with a public verification record."
              />
              {data.certificates.length ? (
                <div className="panel table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Learner</th>
                        <th>Program</th>
                        <th>Serial</th>
                        <th>Issued</th>
                        <th>Status</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.certificates.filter(matches).map((c: Row) => (
                        <tr key={c.id}>
                          <td>
                            <strong>{c.snapshot.name}</strong>
                          </td>
                          <td>
                            {c.snapshot.program}
                            <small>
                              {c.snapshot.credits} {c.snapshot.creditType} credits
                            </small>
                          </td>
                          <td className="mono">{c.serial}</td>
                          <td>{date(c.issued_at, t)}</td>
                          <td>
                            <Status value={c.revoked_at ? 'revoked' : 'verified'} />
                          </td>
                          <td>
                            <ExternalLink href={`/verify/${t.slug}/${c.verification_code}`}>
                              Verify
                            </ExternalLink>
                            {identity.role === 'admin' && !c.revoked_at && (
                              <button
                                className="text-button danger"
                                onClick={() => {
                                  setSelected(c);
                                  setModal('revoke');
                                }}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="panel">
                  <Empty
                    title="Their achievement starts here."
                    description="Certificates appear after payment, attendance or course completion, license approval and required feedback. Issue eligible certificates from the workshop roster."
                    action={
                      <Button secondary onClick={() => navigate('workshops')}>
                        Open workshops <ArrowRight size={15} />
                      </Button>
                    }
                  />
                </div>
              )}
            </>
          )}
          {paymentOrder && (
            <PaymentModal
              order={paymentOrder}
              tenant={t}
              staff
              onClose={() => setPaymentOrder(null)}
              onUpdated={reload}
            />
          )}
          {page === 'settings' && <Settings tenant={t} settings={data.settings} />}
          <footer className="page-footer">
            <span>Dental Academy OS</span>
            <span>Thoughtfully connected. From booking to certificate.</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {failure && (
        <div className="toast error-toast" role="alert">
          {failure}
          <button className="icon-button" onClick={() => setFailure('')} aria-label="Dismiss error">
            <X size={17} />
          </button>
        </div>
      )}
      {modal === 'program' && (
        <Modal
          title="Create a program"
          subtitle="The reusable curriculum behind your workshops and courses."
          onClose={() => setModal(null)}
        >
          <Form
            label="Create program"
            onSubmit={async (d) => {
              await api('/programs', 'POST', {
                title: d.get('title'),
                specialty: d.get('specialty'),
                description: d.get('description'),
                catalogDetails: catalogDetailsFromForm(d),
                credits: Number(d.get('credits')),
                creditType: d.get('creditType'),
                faculty: d.get('faculty'),
              });
              await done('Program created. Schedule its first workshop when ready.');
            }}
          >
            <Field label="Program title">
              <input name="title" required placeholder="e.g. Contemporary Endodontics" />
            </Field>
            <div className="form-grid">
              <Field label="Specialty">
                <input name="specialty" required placeholder="Endodontics" />
              </Field>
              <Field label="Lead faculty">
                <input name="faculty" />
              </Field>
            </div>
            <Field label="Short description" hint="Used on catalog listing cards.">
              <textarea name="description" rows={3} required />
            </Field>
            <CatalogDetailsEditor />
            <div className="form-grid">
              <Field label="Credit hours">
                <input
                  name="credits"
                  type="number"
                  min="0"
                  max="1000"
                  step="0.5"
                  defaultValue="0"
                  required
                />
              </Field>
              <Field label="Credit type">
                <input
                  name="creditType"
                  defaultValue={t.currency === 'INR' ? 'CDE' : 'CE'}
                  required
                />
              </Field>
            </div>
          </Form>
        </Modal>
      )}
      {['workshop', 'course'].includes(modal || '') && (
        <Modal
          title={modal === 'course' ? 'Create an online course' : 'Schedule a workshop'}
          subtitle="Start as a draft. Review every detail before opening bookings."
          onClose={() => setModal(null)}
        >
          <Form
            label="Create draft"
            onSubmit={async (d) => {
              await api('/offerings', 'POST', {
                programId: d.get('programId'),
                catalogDetails: catalogDetailsFromForm(d),
                kind: modal,
                title: d.get('title'),
                startsAt: d.get('startsAt') || undefined,
                days: Number(d.get('days') || 2),
                venue: d.get('venue') || '',
                capacity: modal === 'workshop' ? Number(d.get('capacity')) : undefined,
                price: Math.round(Number(d.get('price')) * 100),
                credits: Number(d.get('credits')),
                accessDays:
                  modal === 'course' && d.get('accessDays')
                    ? Number(d.get('accessDays'))
                    : undefined,
              });
              await done('Draft created. Review and publish when it is ready.');
            }}
          >
            <Field label="Program">
              <select
                name="programId"
                value={selectedProgram}
                onChange={(e) => setSelectedProgram(e.target.value)}
                required
              >
                <option value="">Select a program</option>
                {data.programs
                  .filter((p: Row) => !p.archived_at)
                  .map((p: Row) => (
                    <option value={p.id} key={p.id}>
                      {p.title}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Offering title">
              <input name="title" required />
            </Field>
            <CatalogDetailsEditor
              offering
              inherited={data.programs.find((p: Row) => p.id === selectedProgram)?.catalog_details}
              summary={data.programs.find((p: Row) => p.id === selectedProgram)?.description}
            />
            {modal === 'workshop' ? (
              <>
                <div className="form-grid">
                  <Field label="Start date & time" hint={`Academy timezone: ${t.timezone}`}>
                    <input name="startsAt" type="datetime-local" required />
                  </Field>
                  <Field label="Number of days">
                    <input name="days" type="number" min="1" max="20" defaultValue="2" required />
                  </Field>
                </div>
                <Field label="Venue">
                  <input name="venue" required />
                </Field>
                <Field label="Seat capacity">
                  <input
                    name="capacity"
                    type="number"
                    min="1"
                    max="10000"
                    defaultValue="24"
                    required
                  />
                </Field>
              </>
            ) : (
              <Field label="Access duration (days)" hint="Leave blank for lifetime access.">
                <input name="accessDays" type="number" min="1" max="36500" defaultValue="180" />
              </Field>
            )}
            <div className="form-grid">
              <Field label={`Price (${t.currency}, before tax)`}>
                <input name="price" type="number" step="0.01" min="1" required />
              </Field>
              <Field label="Credit hours">
                <input
                  key={selectedProgram}
                  name="credits"
                  type="number"
                  min="0"
                  max="1000"
                  step="0.01"
                  defaultValue={
                    data.programs.find((p: Row) => p.id === selectedProgram)?.credits || 0
                  }
                  required
                />
              </Field>
            </div>
          </Form>
        </Modal>
      )}
      {modal === 'lead' && (
        <Modal title="Start a conversation" onClose={() => setModal(null)}>
          <Form
            label="Add lead"
            onSubmit={async (d) => {
              await api('/leads', 'POST', {
                name: d.get('name'),
                mobile: d.get('mobile'),
                email: d.get('email'),
                source: d.get('source'),
                notes: d.get('notes'),
                offeringId: d.get('offeringId') || null,
              });
              await done('Lead added to the inbox.');
            }}
          >
            <Field label="Full name">
              <input name="name" required />
            </Field>
            <div className="form-grid">
              <Field label="Mobile with country code">
                <input name="mobile" type="tel" placeholder="+919876543210" required />
              </Field>
              <Field label="Email">
                <input name="email" type="email" />
              </Field>
            </div>
            <Field label="Offering of interest">
              <select name="offeringId">
                <option value="">General inquiry</option>
                {data.offerings.map((o: Row) => (
                  <option value={o.id} key={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Source">
              <select name="source">
                <option>Phone call</option>
                <option>Walk-in</option>
                <option>Website</option>
                <option>WhatsApp</option>
                <option>Referral</option>
              </select>
            </Field>
            <Field label="Notes">
              <textarea name="notes" rows={3} />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'lead-edit' && selected && (
        <Modal
          title={selected.name}
          subtitle={selected.offering_title || 'General inquiry'}
          onClose={() => setModal(null)}
        >
          <div className="inline-actions">
            <ExternalLink href={`https://wa.me/${selected.mobile.replace(/\D/g, '')}`}>
              Open WhatsApp
            </ExternalLink>
            <a className="text-button" href={'tel:' + selected.mobile}>
              {selected.mobile}
            </a>
          </div>
          {!access.manageLeads ? (
            <div className="detail-summary">
              <div>
                <small>Stage</small>
                <Status value={selected.stage} />
              </div>
              <div>
                <small>Source</small>
                <strong>{selected.source}</strong>
              </div>
              <div>
                <small>Notes</small>
                <p style={{ whiteSpace: 'pre-wrap' }}>{selected.notes || 'No notes yet.'}</p>
              </div>
              {selected.lost_reason && (
                <div>
                  <small>Lost reason</small>
                  <p>{selected.lost_reason}</p>
                </div>
              )}
            </div>
          ) : (
            <Form
              onSubmit={async (d) => {
                await api('/leads/' + selected.id, 'PATCH', {
                  stage: d.get('stage'),
                  notes: d.get('notes'),
                  lostReason: d.get('lostReason') || undefined,
                });
                await done('Lead updated.');
              }}
            >
              <Field label="Stage">
                <select name="stage" defaultValue={selected.stage}>
                  {['new', 'contacted', 'interested', 'payment_link_sent', 'won', 'lost'].map(
                    (v) => (
                      <option key={v} value={v}>
                        {v.replaceAll('_', ' ')}
                      </option>
                    ),
                  )}
                </select>
              </Field>
              <Field label="Notes">
                <textarea name="notes" rows={5} defaultValue={selected.notes} />
              </Field>
              <Field label="Lost reason (required if lost)">
                <input name="lostReason" defaultValue={selected.lost_reason || ''} />
              </Field>
            </Form>
          )}
        </Modal>
      )}
      {modal === 'license' && selected && (
        <Modal
          title="Review professional license"
          subtitle={selected.name}
          onClose={() => setModal(null)}
        >
          <div className="detail-summary">
            <div>
              <small>Registration number</small>
              <strong>{selected.license_number || 'Not provided'}</strong>
            </div>
            <div>
              <small>Issuing council / state</small>
              <strong>{selected.license_council || 'Not provided'}</strong>
            </div>
          </div>
          <Form
            label="Save verification"
            onSubmit={async (d) => {
              await api('/contacts/' + selected.id + '/license', 'PATCH', {
                status: d.get('status'),
                note: d.get('note'),
              });
              await done('License review saved with an audit record.');
            }}
          >
            <Field label="Decision">
              <select name="status">
                <option value="verified">Verified</option>
                <option value="rejected">Rejected — needs correction</option>
              </select>
            </Field>
            <Field
              label="Verification note"
              hint="Record the evidence or reason for this decision."
            >
              <textarea name="note" rows={3} required minLength={3} />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'revoke' && selected && (
        <Modal
          title="Revoke certificate"
          subtitle="The public verification page will show this certificate as revoked."
          onClose={() => setModal(null)}
        >
          <Form
            label="Revoke certificate"
            onSubmit={async (d) => {
              await api('/certificates/' + selected.id + '/revoke', 'POST', {
                reason: d.get('reason'),
              });
              await done('Certificate revoked.');
            }}
          >
            <Field label="Reason">
              <textarea name="reason" required minLength={3} />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'switch' && (
        <Modal
          title="Switch academy"
          subtitle="Each academy has its own access permissions and data."
          onClose={() => setModal(null)}
        >
          <p>You are signed in to {t.name}. Sign out to authenticate with another academy.</p>
          <Button onClick={logout}>
            Sign out and switch <ArrowRight size={16} />
          </Button>
        </Modal>
      )}
      {modal === 'help' && (
        <Modal title="Your academy workspace" onClose={() => setModal(null)}>
          <p>
            Programs hold your reusable curriculum. Workshops are dated runs with seats and
            attendance. Online courses have lessons and post-tests.
          </p>
          <p>
            Use the lead inbox for follow-ups, learner profiles for license verification, and the
            workshop roster for attendance and certificate eligibility.
          </p>
          <div className="notice">
            This development environment uses sample data. See the release checklist in the project
            for current launch readiness and outstanding integrations.
          </div>
        </Modal>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  foot,
  icon,
  amber = false,
}: {
  label: string;
  value: string;
  foot: string;
  icon?: React.ReactNode;
  amber?: boolean;
}) {
  return (
    <div className={'metric ' + (amber ? 'metric-amber' : '')}>
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <small>{foot}</small>
    </div>
  );
}
function Priority({
  icon,
  title,
  subtitle,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button className="priority" onClick={onClick}>
      <div className="priority-icon">{icon}</div>
      <div>
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </div>
      <b>{count}</b>
      <ArrowUpRight size={17} />
    </button>
  );
}
function WorkshopCard({
  o,
  tenant,
  index,
  onOpen,
}: {
  o: Row;
  tenant: Row;
  index: number;
  onOpen: () => void;
}) {
  return (
    <button className="workshop-card" onClick={onOpen}>
      <div className={'workshop-art tone-' + (index % 3)}>
        <div className="date-block">
          <strong>{new Date(o.starts_at).getDate()}</strong>
          <span>
            {new Date(o.starts_at).toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
          </span>
        </div>
        <div className="abstract-lines">
          <i />
          <i />
          <i />
        </div>
        <span className="art-label">{o.specialty.toUpperCase()}</span>
      </div>
      <div className="workshop-body">
        <div className="card-eyebrow">
          <span>
            {o.credits} {o.credit_type} CREDITS
          </span>
          <Status value={o.archived_at ? 'archived' : o.status} />
        </div>
        <h3>{o.title}</h3>
        <p>
          <MapPin size={13} />
          {o.venue}
        </p>
        <div className="seat-label">
          <span>
            <strong>{o.enrolled}</strong> of {o.capacity} seats filled
          </span>
          <b>{Math.round((o.enrolled / o.capacity) * 100)}%</b>
        </div>
        <div className="progress-track">
          <i style={{ width: `${Math.min(100, (o.enrolled / o.capacity) * 100)}%` }} />
        </div>
        <div className="card-bottom">
          <div className="faculty-mini">
            <span className="avatar small">{initials(o.faculty[0]?.name || 'F')}</span>
            <span>{o.faculty[0]?.name || 'Faculty TBC'}</span>
          </div>
          <ArrowUpRight size={18} />
        </div>
      </div>
    </button>
  );
}
function RunDetail({
  o,
  tenant,
  access,
  onBack,
  notify,
  reload,
}: {
  o: Row;
  tenant: Row;
  access: Row;
  onBack: () => void;
  notify: (s: string) => void;
  reload: () => Promise<any>;
}) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [checkin, setCheckin] = useState<Row | null>(null),
    [status, setStatus] = useState(o.status);
  const load = () =>
    api('/offerings/' + o.id + '/roster')
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [o.id]);
  useEffect(() => setStatus(o.status), [o.status]);
  const publish = async () => {
    try {
      const next = status === 'open' ? 'closed' : 'open';
      await api('/offerings/' + o.id + '/status', 'PATCH', { status: next });
      setStatus(next);
      await reload();
      notify(next === 'open' ? 'Bookings are open.' : 'Bookings are closed.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <button className="text-button back-link" onClick={onBack}>
        ← All workshops
      </button>
      <PageHeading
        title={o.title}
        subtitle={`${date(o.starts_at, tenant)} – ${date(o.ends_at, tenant)} · ${o.venue}`}
        action={
          access.editCatalog ? (
            <div className="inline-actions">
              <FacultyAssignment offeringId={o.id} notify={notify} />
              {!o.archived_at && (
                <Button secondary onClick={publish}>
                  {status === 'open' ? 'Close bookings' : 'Open bookings'}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {access.editCatalog && (
        <div className="inline-actions catalog-actions">
          <OfferingActions
            id={o.id}
            tenant={tenant}
            onSaved={async (message) => {
              await reload();
              await load();
              notify(message);
            }}
          />
        </div>
      )}
      <div className="run-summary">
        <Status value={o.archived_at ? 'archived' : status} />
        <span>
          <UsersRound size={16} />
          {o.enrolled} / {o.capacity} enrolled
        </span>
        <span>
          <Award size={16} />
          {o.credits} credits
        </span>
        {!access.teachingOnly && (
          <ExternalLink href={`/book/${tenant.slug}/${o.slug}`}>Open checkout</ExternalLink>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <WorkshopCourses workshopId={o.id} editable={access.editCatalog} />
      <section className="panel table-wrap">
        <div className="panel-title">
          <h2>Session schedule</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Starts</th>
              <th>Ends</th>
              <th>Credits</th>
            </tr>
          </thead>
          <tbody>
            {data?.sessions.map((s: Row) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>
                  {new Date(s.starts_at).toLocaleString(tenant.locale, {
                    timeZone: tenant.timezone,
                  })}
                </td>
                <td>
                  {new Date(s.ends_at).toLocaleString(tenant.locale, { timeZone: tenant.timezone })}
                </td>
                <td>{s.credits}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted schedule-timezone">Times shown in {tenant.timezone}.</p>
      </section>
      {access.viewRoster && (
        <>
          <div className="section-heading">
            <div>
              <h2>Your workshop roster</h2>
              <p>
                {access.issueCertificates
                  ? 'Check in each session. Issue certificates when every requirement is met.'
                  : 'Record attendance for each session in your assigned workshop.'}
              </p>
            </div>
          </div>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Learner</th>
                  {!access.teachingOnly && (
                    <>
                      <th>Payment</th>
                      <th>License</th>
                    </>
                  )}
                  {data?.sessions.map((s: Row) => (
                    <th key={s.id}>{s.title.split(' · ')[0]}</th>
                  ))}
                  {access.issueCertificates && <th>Certificate</th>}
                </tr>
              </thead>
              <tbody>
                {data?.roster.map((e: Row) => (
                  <tr key={e.id}>
                    <td>
                      <strong>{e.name || `Unassigned seat ${e.seat_number}`}</strong>
                      <small>{e.mobile}</small>
                    </td>
                    {!access.teachingOnly && (
                      <>
                        <td>
                          <Status value={e.paid >= e.total ? 'paid' : 'partial'} />
                          <small>
                            {money(e.paid, tenant)} / {money(e.total, tenant)}
                          </small>
                        </td>
                        <td>
                          <Status value={e.license_status || 'pending'} />
                        </td>
                      </>
                    )}
                    {data.sessions.map((s: Row) => {
                      const checked = data.attendance.some(
                        (a: Row) => a.enrollment_id === e.id && a.session_id === s.id,
                      );
                      return (
                        <td key={s.id}>
                          <button
                            className={'checkin ' + (checked ? 'checked' : '')}
                            disabled={checked || !e.name}
                            aria-label={`${checked ? 'Checked in' : 'Check in'} ${e.name || 'unassigned learner'} ${s.title}`}
                            onClick={() =>
                              setCheckin({
                                enrollmentId: e.id,
                                sessionId: s.id,
                                name: e.name,
                                session: s.title,
                              })
                            }
                          >
                            {checked ? (
                              <>
                                <Check size={14} />
                                Present
                              </>
                            ) : (
                              'Check in'
                            )}
                          </button>
                        </td>
                      );
                    })}
                    {access.issueCertificates && (
                      <td>
                        {e.state === 'certified' ? (
                          <Badge tone="positive">Issued</Badge>
                        ) : (
                          <button
                            className="text-button"
                            onClick={async () => {
                              try {
                                await api('/certificates', 'POST', { enrollmentId: e.id });
                                notify('Certificate issued.');
                                await load();
                                await reload();
                              } catch (err) {
                                setError((err as Error).message);
                              }
                            }}
                          >
                            Issue <ArrowUpRight size={14} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {data && !data.roster.length && (
              <Empty
                title="Your next cohort starts here."
                description="Confirmed learners will appear after payment."
              />
            )}
          </div>
        </>
      )}
      {checkin && (
        <Modal
          title="Record attendance"
          subtitle={`${checkin.name} · ${checkin.session}`}
          onClose={() => setCheckin(null)}
        >
          <Form
            label="Confirm check-in"
            onSubmit={async (d) => {
              await api('/attendance', 'POST', {
                enrollmentId: checkin.enrollmentId,
                sessionId: checkin.sessionId,
                reason: d.get('reason'),
              });
              setCheckin(null);
              await load();
              notify('Attendance recorded.');
            }}
          >
            <Field label="Manual check-in reason">
              <input
                name="reason"
                defaultValue="Learner present; checked in at registration desk"
                required
                minLength={3}
              />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
function CourseBuilder({
  o,
  tenant,
  access,
  onBack,
  notify,
  reload,
}: {
  o: Row;
  tenant: Row;
  access: Row;
  onBack: () => void;
  notify: (s: string) => void;
  reload: () => Promise<any>;
}) {
  const [data, setData] = useState<Row | null>(null),
    [accessRevision, setAccessRevision] = useState(0),
    [modal, setModal] = useState(''),
    [quizEditRevision, setQuizEditRevision] = useState(0),
    [error, setError] = useState(''),
    [status, setStatus] = useState(o.status),
    [questions, setQuestions] = useState<Row[]>([]),
    [preview, setPreview] = useState<Row | null>(null);
  const load = () =>
    api('/courses/' + o.id + '/builder')
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [o.id]);
  useEffect(() => setStatus(o.status), [o.status]);
  return (
    <>
      <button className="text-button back-link" onClick={onBack}>
        ← All courses
      </button>
      <PageHeading
        title={o.title}
        subtitle="A purposeful learning journey, one lesson at a time."
        action={
          access.editCatalog ? (
            <div className="inline-actions">
              <FacultyAssignment offeringId={o.id} notify={notify} />
              {!o.archived_at && (
                <Button onClick={() => setModal('publication')}>
                  {status === 'open' ? 'Close enrollment' : 'Review & publish'}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {access.editCatalog && (
        <div className="inline-actions catalog-actions">
          <OfferingActions
            id={o.id}
            tenant={tenant}
            onSaved={async (message) => {
              await reload();
              await load();
              notify(message);
            }}
          />
        </div>
      )}
      <div className="run-summary">
        <Status value={o.archived_at ? 'archived' : status} />
        <span>{o.credits} credits</span>
        {!access.teachingOnly && (
          <ExternalLink href={`/book/${tenant.slug}/${o.slug}`}>Open course checkout</ExternalLink>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {modal === 'publication' && (
        <CoursePublication
          courseId={o.id}
          status={status}
          onClose={() => setModal('')}
          onPublished={async (next) => {
            setStatus(next);
            await reload();
            await load();
            notify(
              next === 'open'
                ? 'Course enrollment is open.'
                : 'Enrollment closed. Current learners keep access.',
            );
          }}
        />
      )}
      <div className="builder-layout">
        <CourseCurriculum
          courseId={o.id}
          data={data}
          access={access}
          reload={load}
          notify={notify}
          preview={setPreview}
        />
        <div>
          <section className="panel builder-aside">
            <Award size={28} />
            <h2>Completion rules</h2>
            <p>All required lessons, a passed post-test and a verified professional license.</p>
            <hr />
            <strong>Post-test</strong>
            <p>
              {data?.quiz
                ? `${data.quiz.questions?.length ?? data.quiz.question_count} questions · ${data.quiz.pass_mark}% pass mark · ${data.quiz.max_attempts} attempts`
                : 'No post-test added yet.'}
            </p>
            {access.editCatalog && (
              <Button
                secondary
                onClick={() => {
                  setQuestions(
                    data?.quiz?.questions || [
                      { id: crypto.randomUUID(), prompt: '', options: ['', ''], correct: 0 },
                    ],
                  );
                  setQuizEditRevision(data?.quiz?.revision || 0);
                  setModal('quiz');
                }}
              >
                Edit post-test
              </Button>
            )}
            {access.editCatalog && data?.quiz && (
              <Button secondary onClick={() => setModal('quizHistory')}>
                Version history
              </Button>
            )}
          </section>
          {access.editCatalog && (
            <div className="notice">
              Upload teaching files through the lesson editor. Documents and videos must be ready
              before you can attach them to a lesson.
            </div>
          )}
        </div>
      </div>
      {access.editCatalog && (
        <CourseAccess
          courseId={o.id}
          tenant={tenant}
          onChanged={() => setAccessRevision((n) => n + 1)}
        />
      )}
      {access.viewRoster && (
        <CourseLearners
          key={accessRevision}
          courseId={o.id}
          tenant={tenant}
          revision={data?.revision}
        />
      )}
      {preview && (
        <LessonPreview offeringId={o.id} lesson={preview} onClose={() => setPreview(null)} />
      )}
      {modal === 'quizHistory' && (
        <QuizHistory courseId={o.id} tenant={tenant} onClose={() => setModal('')} />
      )}
      {modal === 'quiz' && (
        <Modal
          title="Configure post-test"
          subtitle="Set a pass mark and choose the correct answer for each question."
          onClose={() => setModal('')}
        >
          <Form
            label="Save post-test"
            onSubmit={async (d) => {
              await api('/courses/' + o.id + '/quiz', 'PUT', {
                revision: quizEditRevision,
                changeReason: d.get('changeReason'),
                passMark: Number(d.get('passMark')),
                maxAttempts: Number(d.get('maxAttempts')),
                questions,
              });
              setModal('');
              await load();
              notify('Post-test saved.');
            }}
          >
            <div className="form-grid">
              <Field label="Pass mark (%)">
                <input
                  name="passMark"
                  type="number"
                  min="1"
                  max="100"
                  defaultValue={data?.quiz?.pass_mark || 70}
                  required
                />
              </Field>
              <Field label="Maximum attempts">
                <input
                  name="maxAttempts"
                  type="number"
                  min="1"
                  max="20"
                  defaultValue={data?.quiz?.max_attempts || 3}
                  required
                />
              </Field>
            </div>
            <div className="notice">
              This saves version {quizEditRevision + 1}. Existing scores, passes and certificates
              remain valid. Attempt limits include attempts from previous versions.
            </div>
            <Field label="Reason for this revision">
              <textarea
                name="changeReason"
                minLength={5}
                maxLength={1000}
                required
                placeholder="Explain the content or scoring change for your academy’s records."
              />
            </Field>
            <div className="question-editor">
              {questions.map((q, n) => (
                <fieldset key={q.id} className="question-editor-item">
                  <legend>Question {n + 1}</legend>
                  <Field label="Question">
                    <input
                      required
                      value={q.prompt}
                      onChange={(e) =>
                        setQuestions(
                          questions.map((v, j) => (j === n ? { ...v, prompt: e.target.value } : v)),
                        )
                      }
                    />
                  </Field>
                  {q.options.map((option: string, k: number) => (
                    <div className="answer-editor" key={k}>
                      <input
                        type="radio"
                        aria-label={`Mark answer ${k + 1} correct for question ${n + 1}`}
                        name={'correct-' + q.id}
                        checked={q.correct === k}
                        onChange={() =>
                          setQuestions(
                            questions.map((v, j) => (j === n ? { ...v, correct: k } : v)),
                          )
                        }
                      />
                      <input
                        aria-label={`Answer ${k + 1} for question ${n + 1}`}
                        value={option}
                        placeholder={`Answer ${k + 1}`}
                        required
                        onChange={(e) =>
                          setQuestions(
                            questions.map((v, j) =>
                              j === n
                                ? {
                                    ...v,
                                    options: v.options.map((a: string, x: number) =>
                                      x === k ? e.target.value : a,
                                    ),
                                  }
                                : v,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                  <small>Select the circle beside the correct answer.</small>
                  <div className="inline-actions">
                    {q.options.length < 8 && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setQuestions(
                            questions.map((v, j) =>
                              j === n ? { ...v, options: [...v.options, ''] } : v,
                            ),
                          )
                        }
                      >
                        + Add answer
                      </button>
                    )}
                    {questions.length > 1 && (
                      <button
                        type="button"
                        className="text-button danger"
                        onClick={() => setQuestions(questions.filter((_, j) => j !== n))}
                      >
                        Remove question
                      </button>
                    )}
                  </div>
                </fieldset>
              ))}
              <Button
                secondary
                onClick={() =>
                  setQuestions([
                    ...questions,
                    { id: crypto.randomUUID(), prompt: '', options: ['', ''], correct: 0 },
                  ])
                }
              >
                <Plus size={14} />
                Add question
              </Button>
            </div>
          </Form>
        </Modal>
      )}
    </>
  );
}
function Settings({ tenant, settings }: { tenant: Row; settings: Row }) {
  const [integrations, setIntegrations] = useState<Row>({}),
    [audit, setAudit] = useState<Row[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api('/integrations'), api('/audit')])
      .then(([i, a]) => {
        setIntegrations(i);
        setAudit(a);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <PageHeading
        title="Configured for your academy."
        subtitle="One platform. Your region, your credentials, your integrations."
      />
      {error && <p className="error">{error}</p>}
      {settings && (
        <>
          <TeamSettings />
          <WebsiteIntegration academySlug={tenant.slug} />
          <PaymentPolicy />
          {advancedFinanceEnabled && (
            <>
              <CancellationPolicySettings />
              <BillingSettings tenant={tenant} />
            </>
          )}
        </>
      )}
      <div className="settings-grid">
        <section className="panel settings-panel">
          <h2>Academy profile</h2>
          {[
            ['Academy', tenant.name],
            ['Currency', tenant.currency],
            ['Timezone', tenant.timezone],
            ['Payment adapter', settings?.payment_provider],
            ['Credit framework', settings?.credit_config?.framework || 'Not configured'],
          ].map(([k, v]) => (
            <div className="setting-row" key={k}>
              <span>{k}</span>
              <strong>{v}</strong>
            </div>
          ))}
          <div className="notice">
            Provider credentials are supplied through the server secret store. Configuration and
            launch approval are tracked in the release checklist.
          </div>
        </section>
        <section className="panel settings-panel">
          <h2>Connected services</h2>
          {Object.entries(integrations).map(([k, v]) => (
            <div className="setting-row" key={k}>
              <span className="capitalize">{k}</span>
              <Badge tone={v ? 'positive' : 'amber'}>{v ? 'Configured' : 'Not connected'}</Badge>
            </div>
          ))}
        </section>
      </div>
      <section className="panel table-wrap audit-panel">
        <div className="panel-title">
          <div>
            <h2>Activity & audit trail</h2>
            <p>Staff writes retain who changed what, and when.</p>
          </div>
          <Activity size={19} />
        </div>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Record</th>
            </tr>
          </thead>
          <tbody>
            {audit.slice(0, 30).map((a) => (
              <tr key={a.id}>
                <td>
                  {new Date(a.created_at).toLocaleString(tenant.locale, {
                    timeZone: tenant.timezone,
                  })}
                </td>
                <td className="mono">{a.actor_id.slice(0, 12)}</td>
                <td>{a.action.toLowerCase()}</td>
                <td>{a.entity.replaceAll('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!audit.length && (
          <Empty title="A clean slate." description="Your first changes will appear here." />
        )}
      </section>
    </>
  );
}
