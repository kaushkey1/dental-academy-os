import { randomUUID } from 'node:crypto';
import { type Database, tenantTx, one } from './db.ts';
export const tenantIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
export async function seed(db: Database) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Sample seeding is prohibited in production');
  if (await one(db, 'SELECT id FROM tenant_directory LIMIT 1')) return;
  const configs = [
    {
      slug: 'icode',
      name: 'Icode India',
      currency: 'INR',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
      provider: 'razorpay',
      city: 'Gurugram',
      credit: 'CDE',
      price: 3500000,
    },
    {
      slug: 'skillodontics',
      name: 'Skillodontics',
      currency: 'USD',
      locale: 'en-US',
      timezone: 'America/Chicago',
      provider: 'stripe',
      city: 'Houston',
      credit: 'CE',
      price: 240000,
    },
  ];
  for (const [i, c] of configs.entries()) {
    const tenant = tenantIds[i];
    await db.query(
      'INSERT INTO tenant_directory(id,slug,name,currency,locale,timezone) VALUES($1,$2,$3,$4,$5,$6)',
      [tenant, c.slug, c.name, c.currency, c.locale, c.timezone],
    );
    await tenantTx(db, tenant, 'system', async (tx) => {
      await tx.query(
        'INSERT INTO tenants(tenant_id,payment_provider,tax_config,credit_config,settings) VALUES($1,$2,$3,$4,$5)',
        [
          tenant,
          c.provider,
          JSON.stringify({
            enabled: false,
            notice: 'Tax configuration requires academy approval',
            state: '06',
            sac: '999293',
          }),
          JSON.stringify({
            framework: c.credit,
            accreditation: 'Unconfigured — sample environment',
          }),
          JSON.stringify({
            sample: true,
            fillThreshold: 60,
            publicApiKey: 'pk_development_' + c.slug,
          }),
        ],
      );
      await tx.query('INSERT INTO staff(tenant_id,id,email,name,role) VALUES($1,$2,$3,$4,$5)', [
        tenant,
        randomUUID(),
        'admin@example.com',
        'Alex Morgan',
        'admin',
      ]);
      const topics = [
        ['Contemporary Endodontics', 'Endodontics', 'Dr. Meera Sharma', 16],
        ['The Implant Essentials', 'Implantology', 'Dr. Arjun Rao', 18],
        ['Anterior Aesthetics', 'Restorative dentistry', 'Dr. Kavya Menon', 12],
        ['Clinical Photography Foundations', 'Practice essentials', 'Dr. Rohan Shah', 4],
      ];
      for (const [j, topic] of topics.entries()) {
        const program = randomUUID(),
          offering = randomUUID(),
          ticket = randomUUID(),
          course = j === 3;
        const title = String(topic[0]),
          slug = title.toLowerCase().replaceAll(' ', '-');
        await tx.query(
          'INSERT INTO programs(tenant_id,id,title,slug,specialty,description,faculty,credits,credit_type,published) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)',
          [
            tenant,
            program,
            title,
            slug,
            topic[1],
            'Sample catalog content. Replace with the academy-approved curriculum, learning objectives and faculty information before publishing.',
            JSON.stringify([{ name: topic[2], credentials: 'Sample faculty' }]),
            topic[3],
            c.credit,
          ],
        );
        const start = new Date(Date.now() + (26 + j * 7) * 86400000),
          end = new Date(start.getTime() + 32 * 3600000);
        await tx.query(
          'INSERT INTO offerings(tenant_id,id,program_id,kind,title,slug,status,starts_at,ends_at,venue,capacity,credits,access_days,require_feedback) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            tenant,
            offering,
            program,
            course ? 'course' : 'workshop',
            title,
            slug + (course ? '' : '-november-2026'),
            'open',
            course ? null : start,
            course ? null : end,
            course ? 'Online' : `${c.city} · Academy Training Centre`,
            course ? null : 24,
            topic[3],
            course ? 180 : null,
            !course,
          ],
        );
        await tx.query(
          'INSERT INTO tickets(tenant_id,id,offering_id,name,price,deposit) VALUES($1,$2,$3,$4,$5,$6)',
          [
            tenant,
            ticket,
            offering,
            course ? 'Course access' : 'Standard admission',
            course ? Math.round(c.price / 8) : c.price,
            course ? null : Math.round(c.price / 3),
          ],
        );
        const sessionIds: string[] = [];
        if (!course)
          for (let d = 0; d < 2; d++) {
            const sid = randomUUID();
            sessionIds.push(sid);
            const a = new Date(start.getTime() + d * 86400000),
              b = new Date(a.getTime() + 8 * 3600000);
            await tx.query(
              'INSERT INTO sessions(tenant_id,id,offering_id,title,starts_at,ends_at,credits) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [
                tenant,
                sid,
                offering,
                `Day ${d + 1} · Hands-on workshop`,
                a,
                b,
                Number(topic[3]) / 2,
              ],
            );
          }
        if (course) {
          for (let l = 0; l < 3; l++)
            await tx.query(
              'INSERT INTO lessons(tenant_id,id,offering_id,module_title,title,kind,position,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                tenant,
                randomUUID(),
                offering,
                'Getting started',
                ['Welcome to your course', 'Your learning workspace', 'Course reflection'][l],
                'text',
                l,
                'This is sample lesson content for validating the learning workflow. Academy-approved teaching materials will be loaded before launch. Complete the required lessons, then submit the post-test to finish your learning journey.',
              ],
            );
          await tx.query('INSERT INTO quizzes(tenant_id,offering_id,questions) VALUES($1,$2,$3)', [
            tenant,
            offering,
            JSON.stringify([
              {
                id: 'q1',
                prompt: 'Which action completes this sample course?',
                options: [
                  'Complete required lessons and pass the post-test',
                  'Only open the course',
                  'Only make a payment',
                ],
                correct: 0,
              },
            ]),
          ]);
        }
        const names = [
          'Aarav Mehta',
          'Riya Kapoor',
          'Nikhil Sethi',
          'Ananya Rao',
          'Kabir Shah',
          'Ishita Jain',
          'Dev Patel',
          'Maya Nair',
          'Rohan Gupta',
          'Tara Bhat',
          'Neel Joshi',
          'Sana Ali',
          'Arjun Das',
          'Pooja Shah',
        ];
        const count = course ? 3 : [14, 9, 5][j];
        for (let n = 0; n < count; n++) {
          const contact = randomUUID(),
            order = randomUUID(),
            enrollment = randomUUID(),
            price = course ? Math.round(c.price / 8) : c.price;
          const mobile = `+${i ? 1 : 91}${9000000000 + j * 100 + n}`;
          await tx.query(
            'INSERT INTO contacts(tenant_id,id,name,mobile,email,clinic,license_number,license_council,license_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              tenant,
              contact,
              'Dr. ' + names[n],
              mobile,
              `learner${j}${n}@example.com`,
              'Sample Dental Studio',
              `SAMPLE-${j}${n}`,
              i ? 'Texas' : 'Delhi State Council',
              n % 4 === 0 ? 'pending' : 'verified',
            ],
          );
          const paid = n % 4 === 0 && !course ? Math.round(price / 3) : price;
          await tx.query(
            'INSERT INTO orders(tenant_id,id,contact_id,offering_id,ticket_id,quantity,subtotal,total,due_now,paid,currency,status,hold_expires_at,provider,idempotency_key,url_params) VALUES($1,$2,$3,$4,$5,1,$6,$6,$6,$7,$8,$9,now(),$10,$11,$12)',
            [
              tenant,
              order,
              contact,
              offering,
              ticket,
              price,
              paid,
              c.currency,
              paid < price ? 'partial' : 'paid',
              'sample',
              randomUUID(),
              JSON.stringify({
                utm_source: n % 2 ? 'instagram' : 'direct',
                utm_campaign: 'november-workshops',
              }),
            ],
          );
          await tx.query(
            'INSERT INTO enrollments(tenant_id,id,order_id,offering_id,contact_id,seat_number,expires_at) VALUES($1,$2,$3,$4,$5,1,$6)',
            [
              tenant,
              enrollment,
              order,
              offering,
              contact,
              course ? new Date(Date.now() + 180 * 86400000) : null,
            ],
          );
          if (n < 2 && !course)
            await tx.query(
              'INSERT INTO leads(tenant_id,id,contact_id,offering_id,kind,source,notes) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [
                tenant,
                randomUUID(),
                contact,
                offering,
                'manual',
                'Phone call',
                'Sample follow-up: confirm travel and workshop kit preferences.',
              ],
            );
        }
      }
    });
  }
}
