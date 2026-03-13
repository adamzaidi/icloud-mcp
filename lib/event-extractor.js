// ─── lib/event-extractor.js — Email content formatter for calendar extraction ─
// Returns structured email content for Claude to extract event details from.
// No external API calls — Claude (the calling model) does the extraction natively.

export function formatEmailForExtraction(email) {
  const sentAt = new Date(email.date);
  const sentFormatted = sentAt.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return {
    // Raw email fields
    subject: email.subject,
    from: email.from,
    sentAt: sentFormatted,
    sentAtIso: email.date,
    body: email.body,

    // Anchor hint for relative date resolution
    _dateAnchor: `The email was sent on ${sentFormatted}. Use this as the reference when resolving relative dates like "Tuesday", "tomorrow", or "next week".`,

    // Extraction instructions for Claude
    _instructions: [
      'Review the email above and extract the following calendar event fields:',
      '  • summary       — event title',
      '  • start         — ISO 8601 datetime (resolve relative dates using sentAt as anchor)',
      '  • end           — ISO 8601 datetime (estimate if not stated)',
      '  • estimatedEnd  — true if end time was not explicitly stated',
      '  • allDay        — true if no specific time is given',
      '  • timezone      — IANA timezone (infer from location if not stated)',
      '  • location      — full venue name and address',
      '  • description   — full agenda, parking info, and any other relevant details',
      '  • attendees     — array of named people with role/title if mentioned',
      '  • organizer     — who sent or organized this',
      '  • confidence    — high / medium / low',
      '  • notes         — anything ambiguous or worth flagging to the user',
      'Present the extracted fields to the user for confirmation before calling create_event.',
    ].join('\n'),
  };
}
