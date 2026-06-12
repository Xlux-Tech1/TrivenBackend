import axios from 'axios';
import { config } from 'dotenv';
config();

const INTERAKT_API_KEY = process.env.INTERAKT_API_KEY;

// Ensure we have a valid key, otherwise log a warning
if (!INTERAKT_API_KEY) {
  console.warn('⚠️ INTERAKT_API_KEY is not defined in .env. Interakt APIs will fail.');
}

const getHeaders = () => ({
  'Authorization': `Basic ${INTERAKT_API_KEY}`,
  'Content-Type': 'application/json'
});

/**
 * Track a User in Interakt
 * @param {Object} lead - The lead document
 */
export const trackUser = async (lead) => {
  if (!INTERAKT_API_KEY || !lead.phone) return;
  try {
    // Interakt expects countryCode and phoneNumber. Assuming standard 10 digit indian phone numbers with +91 country code.
    let phone = lead.phone.trim();
    let countryCode = '+91';
    
    if (phone.startsWith('+')) {
      countryCode = phone.substring(0, 3);
      phone = phone.substring(3);
    }

    const payload = {
      userId: String(lead._id),
      countryCode,
      phoneNumber: phone,
      traits: {
        name: lead.name,
        email: lead.email,
        department: lead.department || 'General',
        status: lead.status,
        source: lead.source || 'Manual',
        problem: lead.problem || ''
      }
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/track/users/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Interakt Track User Error:', error?.response?.data || error.message);
  }
};

/**
 * Track an Event for a User in Interakt
 * @param {String} leadId - The lead document ID
 * @param {String} eventName - The name of the event
 * @param {Object} traits - Additional traits to attach to the event
 */
export const trackEvent = async (leadId, eventName, traits = {}) => {
  if (!INTERAKT_API_KEY || !leadId) return;
  try {
    const payload = {
      userId: String(leadId),
      event: eventName,
      traits: traits
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/track/events/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error(`Interakt Track Event (${eventName}) Error:`, error?.response?.data || error.message);
  }
};

/**
 * Send an RCS Standalone or Carousel Message with SMS Fallback
 * @param {Object} params - parameters for sending RCS
 */
export const sendRcsMessage = async ({ countryCode = '+91', phoneNumber, cardTitle, cardDescription, mediaUrl, suggestions = [], smsFallbackContent, dltTemplateId, variables = [] }) => {
  if (!INTERAKT_API_KEY) return;
  try {
    const payload = {
      countryCode,
      phoneNumber,
      message: {
        richCardDetails: {
          standalone: {
            cardOrientation: "VERTICAL",
            content: {
              cardTitle,
              cardDescription,
              cardMedia: mediaUrl ? {
                mediaHeight: "TALL",
                contentInfo: {
                  fileUrl: mediaUrl
                }
              } : undefined,
              suggestions: suggestions.map(sug => ({
                reply: {
                  plainText: sug.text,
                  postBack: {
                    data: sug.data
                  }
                }
              }))
            }
          }
        }
      },
      type: "STANDALONE_CAROUSEL",
      fallback: [
        {
          channel: "sms",
          sender_id: "INTRKT", // Should be replaced with actual DLT Sender ID
          pe_id: "1201159195599372920", // Default from Interakt Docs
          provider_name: "default",
          content: {
            message: smsFallbackContent,
            dlt_te_id: dltTemplateId,
            variables: variables
          }
        }
      ]
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/rcs/message/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Interakt Send RCS Message Error:', error?.response?.data || error.message);
  }
};

/**
 * Send an RCS Template Message with SMS Fallback
 */
export const sendRcsTemplate = async ({ countryCode = '+91', phoneNumber, templateName, languageCode = 'en', carouselCards = [], campaignId, smsFallbackContent, dltTemplateId, variables = [] }) => {
  if (!INTERAKT_API_KEY) return;
  try {
    const payload = {
      countryCode,
      phoneNumber,
      template: {
        name: templateName,
        languageCode,
        carouselCards: carouselCards.map(card => ({
          bodyValues: card.bodyValues
        }))
      },
      type: "Template",
      campaignId,
      fallback: [
        {
          channel: "sms",
          sender_id: "INTRKT", // Replace with actual
          pe_id: "1201159195599372920",
          provider_name: "default",
          content: {
            message: smsFallbackContent,
            dlt_te_id: dltTemplateId,
            variables: variables
          }
        }
      ]
    };

    const response = await axios.post('https://api.interakt.ai/v1/public/rcs/message/', payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Interakt Send RCS Template Error:', error?.response?.data || error.message);
  }
};
