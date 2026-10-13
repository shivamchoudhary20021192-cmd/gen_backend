import { registerProvider } from '../registry';
import { metaWhatsappProvider } from './metaWhatsapp';
import { paypalProvider, razorpayProvider, stripeProvider } from './payments';
import { postmarkProvider } from './postmark';
import { sendgridProvider } from './sendgrid';
import { shiprocketProvider } from './shiprocket';
import { taxjarProvider } from './taxjar';
import { twilioProvider } from './twilio';

/**
 * Every provider in this build. Adding one is a manifest file and a line here;
 * nothing else in the platform changes.
 */
let registered = false;

export function registerBuiltInProviders(): void {
  if (registered) return;
  registered = true;
  for (const manifest of [
    // payments
    razorpayProvider,
    stripeProvider,
    paypalProvider,
    // messaging
    twilioProvider,
    metaWhatsappProvider,
    sendgridProvider,
    postmarkProvider,
    // shipping
    shiprocketProvider,
    // tax
    taxjarProvider,
  ]) {
    registerProvider(manifest);
  }
}

registerBuiltInProviders();
