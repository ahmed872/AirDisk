import {
  DomainError,
  ErrorCode,
  changeNotificationTransition,
  optionalText,
  requiredText,
  type ChangeNotificationStatus,
} from '@airdesk/domain';
import type { NotificationChannelDto, NotificationDto, ScheduleChangeDto, UpcomingTravelDto } from '@airdesk/contracts';
import type { BookingService } from './booking-service';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';

export type Channel = 'WHATSAPP' | 'SMS' | 'EMAIL';

/**
 * Delivery providers. None is connected in this version: the product is
 * offline-first and no provider credentials exist. Notifications are recorded
 * MANUALLY (the agent sends the message from their phone/e-mail and records
 * the outcome). A future provider implements this interface; until then the
 * UI states plainly that automatic sending is not configured.
 */
export interface NotificationProvider {
  readonly channel: Channel;
  isConfigured(): boolean;
  send(to: string, subject: string | null, body: string): Promise<{ providerMessageId: string }>;
}

export class ProviderRegistry {
  private readonly providers = new Map<Channel, NotificationProvider>();
  register(p: NotificationProvider): void {
    this.providers.set(p.channel, p);
  }
  channels(): NotificationChannelDto[] {
    return (['WHATSAPP', 'SMS', 'EMAIL'] as const).map((c) => ({ channel: c, providerConfigured: this.providers.get(c)?.isConfigured() ?? false, manualAvailable: true }));
  }
}

const FIELD_LABELS: Record<string, [string, string]> = {
  departure_date: ['تاريخ الإقلاع', 'Departure date'], departure_time: ['وقت الإقلاع', 'Departure time'],
  arrival_date: ['تاريخ الوصول', 'Arrival date'], arrival_time: ['وقت الوصول', 'Arrival time'], flight_number: ['رقم الرحلة', 'Flight number'],
  origin_iata: ['مطار المغادرة', 'Origin'], destination_iata: ['مطار الوصول', 'Destination'], marketing_airline_id: ['شركة الطيران', 'Airline'],
  operating_airline_id: ['الشركة المشغلة', 'Operating airline'], departure_terminal: ['صالة المغادرة', 'Departure terminal'],
  arrival_terminal: ['صالة الوصول', 'Arrival terminal'], cabin_class: ['درجة السفر', 'Cabin'], status: ['حالة الرحلة', 'Segment status'],
};

export class OperationsService {
  readonly providers = new ProviderRegistry();

  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
    private readonly bookings: BookingService,
  ) {}

  listChanges(actor: Actor, filter: { attentionOnly?: boolean; from?: string; to?: string }): ScheduleChangeDto[] {
    requirePermission(this.deps, actor, ['booking.view', 'report.schedule_changes'], 'schedule.list');
    return this.bookings.scheduleChanges(null, filter).filter((c) => this.canSee(actor, c.bookingId));
  }

  /** Records the notification outcome of a schedule change (Phase 0 §05-5). */
  setChangeStatus(actor: Actor, changeId: string, input: { rowVersion: number; status: ChangeNotificationStatus; note?: string | null; customerResponse?: ScheduleChangeDto['customerResponse'] }): ScheduleChangeDto {
    requirePermission(this.deps, actor, input.status === 'MANUALLY_CONFIRMED' ? 'schedule.confirm' : 'schedule.notify', 'schedule.setStatus');
    tx(this.deps, () => {
      const c = this.change(actor, changeId);
      if (c.row_version !== input.rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'The change was updated by someone else; reload it');
      const to = changeNotificationTransition(c.notification_status, input.status);
      const note = input.status === 'MANUALLY_CONFIRMED' ? requiredText(input.note, 'note', 500) : optionalText(input.note, 'note', 500);
      const now = this.deps.clock.now().toISOString();
      this.deps.db
        .prepare(`UPDATE schedule_change SET notification_status = ?, status_updated_at = ?, status_updated_by = ?, confirmation_note = COALESCE(?, confirmation_note),
                    customer_response = COALESCE(?, customer_response), row_version = row_version + 1 WHERE id = ?`)
        .run(to, now, actor.userId, note, input.customerResponse ?? null, changeId);
      this.deps.audit.append(actorOf(actor), {
        action: 'schedule.notification_status', entityType: 'schedule_change', entityId: changeId,
        before: { status: c.notification_status }, after: { status: to, customerResponse: input.customerResponse ?? null }, metadata: note ? { note } : undefined,
      });
    });
    return this.bookings.scheduleChanges(this.change(actor, changeId).booking_id).find((c) => c.id === changeId)!;
  }

  /**
   * Records a notification the agent sent manually (WhatsApp/SMS/e-mail/phone
   * call) and moves the linked schedule change accordingly. Nothing is sent by
   * the application itself — no provider is configured.
   */
  recordNotification(actor: Actor, input: { bookingId: string; scheduleChangeId?: string | null; channel: NotificationDto['channel']; recipient: string; body: string; outcome: 'SENT' | 'FAILED'; note?: string | null }): NotificationDto {
    requirePermission(this.deps, actor, 'schedule.notify', 'notifications.record');
    const id = tx(this.deps, () => {
      const b = this.bookings.accessible(actor, input.bookingId);
      const now = this.deps.clock.now().toISOString();
      const nid = this.deps.newId();
      let change: { id: string; notification_status: ChangeNotificationStatus } | undefined;
      if (input.scheduleChangeId) {
        change = this.deps.db.prepare('SELECT id, notification_status FROM schedule_change WHERE id = ? AND booking_id = ?').get(input.scheduleChangeId, b.id) as typeof change;
        if (!change) throw new DomainError(ErrorCode.NOT_FOUND, 'Schedule change not found');
      }
      this.deps.db
        .prepare(`INSERT INTO notification (id, channel, delivery_mode, recipient_address, recipient_name, customer_id, booking_id, schedule_change_id, body, status,
                    attempt_count, created_at, created_by, sent_at, sent_by, status_updated_at, note, error_message)
                  VALUES (?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nid, input.channel, requiredText(input.recipient, 'recipient', 120), b.contact_name, b.customer_id, b.id, change?.id ?? null,
          requiredText(input.body, 'body', 4000), input.outcome, now, actor.userId, input.outcome === 'SENT' ? now : null, input.outcome === 'SENT' ? actor.userId : null,
          now, optionalText(input.note, 'note', 500), input.outcome === 'FAILED' ? optionalText(input.note, 'note', 500) ?? 'Not reachable' : null);
      if (change) {
        const target: ChangeNotificationStatus = input.outcome === 'SENT' ? 'CUSTOMER_NOTIFIED' : 'NOTIFICATION_FAILED';
        if (change.notification_status !== target || target === 'NOTIFICATION_FAILED') {
          const to = changeNotificationTransition(change.notification_status, target);
          this.deps.db.prepare('UPDATE schedule_change SET notification_status = ?, status_updated_at = ?, status_updated_by = ?, row_version = row_version + 1 WHERE id = ?').run(to, now, actor.userId, change.id);
        }
      }
      this.deps.audit.append(actorOf(actor), {
        action: 'notification.recorded', entityType: 'notification', entityId: nid,
        metadata: { bookingId: b.id, channel: input.channel, outcome: input.outcome, scheduleChangeId: change?.id ?? null },
      });
      return nid;
    });
    return this.bookings.notifications(input.bookingId).find((n) => n.id === id)!;
  }

  /** Ready-to-send text for a schedule change (the agent copies it into WhatsApp/SMS/e-mail). */
  draftMessage(actor: Actor, changeId: string, locale: 'ar' | 'en'): { body: string; recipient: string; whatsapp: string | null } {
    requirePermission(this.deps, actor, 'schedule.notify', 'notifications.draft');
    const c = this.change(actor, changeId);
    const b = this.deps.db.prepare('SELECT booking_no, primary_pnr, contact_name, contact_mobile, contact_whatsapp FROM booking WHERE id = ?').get(c.booking_id) as
      { booking_no: string; primary_pnr: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null };
    const fields = this.deps.db.prepare('SELECT field_name, old_value, new_value FROM schedule_change_field WHERE change_id = ?').all(changeId) as { field_name: string; old_value: string | null; new_value: string | null }[];
    const company = this.company.core();
    const ar = locale === 'ar';
    const lines = fields.map((f) => `• ${FIELD_LABELS[f.field_name]?.[ar ? 0 : 1] ?? f.field_name}: ${f.old_value ?? '—'} ← ${f.new_value ?? '—'}`);
    const body = ar
      ? [`عميلنا العزيز ${b.contact_name}،`, `نود إبلاغكم بتغيير في موعد رحلتكم (الحجز ${b.primary_pnr ?? b.booking_no}):`, ...lines, 'يرجى التواصل معنا لتأكيد الاستلام.', company.legalNameAr].join('\n')
      : [`Dear ${b.contact_name},`, `Please note a schedule change on your trip (booking ${b.primary_pnr ?? b.booking_no}):`, ...lines.map((l) => l.replace('←', '→')), 'Please contact us to confirm.', this.company.get().legalNameEn ?? company.legalNameAr].join('\n');
    return { body, recipient: b.contact_whatsapp ?? b.contact_mobile, whatsapp: b.contact_whatsapp };
  }

  upcomingTravel(actor: Actor, filter: { from: string; to: string; attentionOnly?: boolean }): UpcomingTravelDto[] {
    requirePermission(this.deps, actor, 'booking.view', 'travel.upcoming');
    const scope = hasAny(actor, 'booking.view_all') ? '' : 'AND (b.sales_agent_id = @me OR b.created_by = @me)';
    const rows = this.deps.db
      .prepare(`SELECT fs.id AS segment_id, fs.booking_id, b.booking_no, b.primary_pnr, fs.departure_date, fs.departure_time, fs.arrival_date, fs.arrival_time,
                       fs.origin_iata, fs.destination_iata, a.iata_code || fs.flight_number AS flight, a.name_en AS airline_name, b.status AS booking_status,
                       fs.status AS segment_status, c.full_name AS customer_name, b.contact_mobile,
                       (SELECT group_concat(p.given_name || ' ' || p.surname, '، ') FROM booking_passenger p WHERE p.booking_id = b.id AND p.status = 'ACTIVE') AS passengers,
                       EXISTS (SELECT 1 FROM schedule_change sc WHERE sc.segment_id = fs.id) AS changed,
                       (SELECT sc.notification_status FROM schedule_change sc WHERE sc.segment_id = fs.id AND sc.superseded_by_id IS NULL ORDER BY sc.changed_at DESC LIMIT 1) AS latest_status
                FROM flight_segment fs JOIN booking b ON b.id = fs.booking_id JOIN customer c ON c.id = b.customer_id JOIN airline a ON a.id = fs.marketing_airline_id
                WHERE fs.departure_date BETWEEN @from AND @to AND b.status IN ('RESERVED','ISSUED','PARTIALLY_CANCELLED') ${scope}
                ORDER BY fs.departure_date, fs.departure_time, b.booking_no LIMIT 1000`)
      .all({ from: filter.from, to: filter.to, me: actor.userId }) as {
        segment_id: string; booking_id: string; booking_no: string; primary_pnr: string | null; departure_date: string; departure_time: string; arrival_date: string;
        arrival_time: string; origin_iata: string; destination_iata: string; flight: string; airline_name: string; booking_status: UpcomingTravelDto['bookingStatus'];
        segment_status: string; customer_name: string; contact_mobile: string; passengers: string | null; changed: number; latest_status: string | null;
      }[];
    return rows
      .map((r) => ({
        segmentId: r.segment_id, bookingId: r.booking_id, bookingNo: r.booking_no, pnr: r.primary_pnr, departureDate: r.departure_date, departureTime: r.departure_time,
        arrivalDate: r.arrival_date, arrivalTime: r.arrival_time, origin: r.origin_iata, destination: r.destination_iata, flight: r.flight, airlineName: r.airline_name,
        passengers: r.passengers ?? '', customerName: r.customer_name, contactMobile: r.contact_mobile, bookingStatus: r.booking_status, segmentStatus: r.segment_status,
        scheduleChanged: r.changed === 1, scheduleAttention: r.latest_status === 'NOT_NOTIFIED' || r.latest_status === 'NOTIFICATION_FAILED', notificationStatus: r.latest_status,
      }))
      .filter((r) => !filter.attentionOnly || r.scheduleAttention);
  }

  channels(): NotificationChannelDto[] {
    return this.providers.channels();
  }

  private change(actor: Actor, id: string): { id: string; booking_id: string; notification_status: ChangeNotificationStatus; row_version: number } {
    const c = this.deps.db.prepare('SELECT id, booking_id, notification_status, row_version FROM schedule_change WHERE id = ?').get(id) as
      { id: string; booking_id: string; notification_status: ChangeNotificationStatus; row_version: number } | undefined;
    if (!c) throw new DomainError(ErrorCode.NOT_FOUND, 'Schedule change not found');
    this.bookings.accessible(actor, c.booking_id);
    return c;
  }

  private canSee(actor: Actor, bookingId: string): boolean {
    try {
      this.bookings.accessible(actor, bookingId);
      return true;
    } catch {
      return false;
    }
  }
}
