import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import * as React from "react";

import { BookingTypeLabel } from "@/lib/constants/labels";
import type { BookingType } from "@/lib/constants/enums";

export interface PaymentConfirmationEmailProps {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;
  customerName: string;
  orderNumber: string;
  bookingType: BookingType;
  amount: string;
  paidOn: string;
  vehicle: { company: string; type: string };
  trip: { pickupDate: string; dropoffDate: string };
  receiptUrl?: string | null;
}

export function PaymentConfirmationEmail({
  brandName,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  paidOn,
  vehicle,
  trip,
  receiptUrl,
}: PaymentConfirmationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        {`${brandName} payment confirmed - ${orderNumber} - ${amount}`}
      </Preview>
      <Tailwind>
        <Body className="bg-[#f6f8fb] font-sans py-8">
          <Container className="bg-white rounded-xl mx-auto max-w-[600px] border border-[#e6e9ee]">
            <Section className="px-8 pt-8 pb-4">
              <Text className="text-xs tracking-[0.18em] font-semibold uppercase text-[#0b6dd6] m-0">
                {brandName}
              </Text>
              <Heading className="text-[#0f172a] text-2xl font-semibold mt-3 mb-2">
                Payment confirmed
              </Heading>
              <Text className="text-[#475569] text-sm m-0 leading-relaxed">
                Hi {customerName}, we&apos;ve received your payment for{" "}
                <strong>{BookingTypeLabel[bookingType]}</strong>. Below is your
                booking summary for your records.
              </Text>
            </Section>

            <Section className="px-8 pb-6">
              <div
                style={{
                  backgroundColor: "#f1f5f9",
                  borderRadius: "12px",
                  padding: "20px 24px",
                }}
              >
                <Row>
                  <Column>
                    <Text className="text-[11px] uppercase tracking-wider text-[#64748b] m-0">
                      Amount paid
                    </Text>
                    <Text className="text-[#0f172a] font-semibold text-xl m-0 mt-1">
                      {amount}
                    </Text>
                  </Column>
                  <Column align="right">
                    <Text className="text-[11px] uppercase tracking-wider text-[#64748b] m-0">
                      Order
                    </Text>
                    <Text className="text-[#0f172a] font-semibold text-sm m-0 mt-1">
                      {orderNumber}
                    </Text>
                  </Column>
                </Row>
              </div>
            </Section>

            <Section className="px-8 pb-6">
              <Heading
                as="h2"
                className="text-[#0f172a] text-sm font-semibold uppercase tracking-wider m-0 mb-4"
              >
                Booking details
              </Heading>
              <DetailRow label="Booking type" value={BookingTypeLabel[bookingType]} />
              <DetailRow label="Vehicle" value={`${vehicle.company} • ${vehicle.type}`} />
              <DetailRow label="Pick-up" value={trip.pickupDate} />
              <DetailRow label="Drop-off" value={trip.dropoffDate} />
              <DetailRow label="Paid on" value={paidOn} />
            </Section>

            {receiptUrl ? (
              <Section className="px-8 pb-6">
                <Text className="text-sm text-[#475569] m-0">
                  A Stripe receipt is available here:{" "}
                  <a
                    href={receiptUrl}
                    style={{ color: "#0b6dd6", textDecoration: "underline" }}
                  >
                    View receipt
                  </a>
                </Text>
              </Section>
            ) : null}

            <Hr className="border-[#e2e8f0] mx-8" />

            <Section className="px-8 py-6">
              <Text className="text-xs text-[#64748b] m-0 leading-relaxed">
                Questions about this booking? Reach our team at{" "}
                <a
                  href={`mailto:${supportEmail}`}
                  style={{ color: "#0b6dd6" }}
                >
                  {supportEmail}
                </a>{" "}
                or {supportPhone}. Please include your order number when
                contacting us.
              </Text>
              <Text className="text-[11px] text-[#94a3b8] m-0 mt-4">
                This is an automated confirmation from {brandName}.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column style={{ paddingBottom: 10 }}>
        <Text className="text-[12px] uppercase tracking-wider text-[#64748b] m-0">
          {label}
        </Text>
      </Column>
      <Column align="right" style={{ paddingBottom: 10 }}>
        <Text className="text-sm text-[#0f172a] font-medium m-0">{value}</Text>
      </Column>
    </Row>
  );
}

export default PaymentConfirmationEmail;
