import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import Lead from '../lead/lead.model.js';
import User from '../user/user.model.js';
import * as leadService from '../lead/lead.service.js';
import streamifier from 'streamifier';
import cloudinary from '../../config/cloudinary.js';
import { sendWhatsAppMessage, sendInteraktChatMessage } from './interakt.service.js';

/**
 * Handle incoming webhooks from Interakt
 */
const handleWebhook = catchAsync(async (req, res) => {
  const payload = req.body;
  
  // DEBUGGING: Log EVERYTHING to database as a lead
  try {
    const rawLeadData = {
      name: `RAW WEBHOOK`,
      phone: `0000000000`,
      source: 'social_media',
      problem: JSON.stringify(payload).substring(0, 500),
      status: 'new'
    };
    await leadService.createLead(rawLeadData, null, 'admin');
  } catch(e) {}

  console.log(`[Interakt Webhook] Received:`, JSON.stringify(payload, null, 2));

  if (!payload || (!payload.entityType && !payload.type)) {
    return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'Invalid payload'));
  }

  try {
    const isMessage = payload.entityType === 'USER_MESSAGE' || payload.type === 'message_received';
    
    if (isMessage) {
      let phone, messageText, customerName, targetDepartment = 'migraine';
      
      if (payload.type === 'message_received' && payload.data) {
        phone = payload.data.customer?.phone_number || payload.data.customer?.phone;
        customerName = payload.data.customer?.traits?.name || `WhatsApp Lead (${phone})`;
        
        // Try to extract text. If not found, stringify the message object so we can see what's inside
        const msgObj = payload.data.message;
        let extractedText = "";
        
        if (typeof msgObj?.message === 'string') {
          extractedText = msgObj.message;
        } else if (msgObj?.message?.text) {
          extractedText = msgObj.message.text;
        } else if (msgObj?.text) {
          extractedText = msgObj.text;
        }

        // Check if there's a Facebook Ad referral
        let referralText = "";
        if (msgObj?.referral?.headline) {
          referralText = `\n[Clicked Ad: ${msgObj.referral.headline}]`;
        }

        messageText = extractedText ? (extractedText + referralText) : (msgObj ? JSON.stringify(msgObj) : "New message received");
        // Extract business phone number to route to the correct department
        let businessPhone = payload.data?.customer?.channel_phone_number || "";
        
        // Determine department based on business phone number
        const fallbackMigraine = "7309523829,917309523829,916376776399,6376776399";
        const migraineNumbers = (process.env.INTERAKT_MIGRAINE_NUMBERS || fallbackMigraine).split(",");
        const haircareNumbers = (process.env.INTERAKT_HAIRCARE_NUMBERS || "").split(",");
        
        targetDepartment = null; // Unassigned by default
        
        if (businessPhone && migraineNumbers.some(num => num.trim() !== "" && businessPhone.includes(num.trim()))) {
            targetDepartment = 'migraine';
        } else if (businessPhone && haircareNumbers.some(num => num.trim() !== "" && businessPhone.includes(num.trim()))) {
            targetDepartment = 'haircare';
        }
        
      } else {
        phone = payload.userPhoneNumber;
        customerName = `WhatsApp Lead (${phone})`;
        messageText = payload.message?.text || payload.entity?.text || payload.entity?.suggestionResponse?.postBack?.data || "New message received";
      }

      console.log(`User ${customerName} (${phone}) sent message: ${messageText} to department ${targetDepartment}`);
      
      // Save this as a note to the corresponding Lead using the phone number
      if (phone && messageText) {
        // Interakt sends phone numbers with + country code, e.g., +9193218...
        if (phone.startsWith('+91')) phone = phone.substring(3);
        else if (phone.startsWith('+')) phone = phone.substring(1);

        let lead = await Lead.findOne({ phone: { $regex: phone.slice(-10) + '$' } });
        const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }).select('_id').lean();
        
        if (!lead) {
          // Auto-create a lead if it doesn't exist
          console.log(`[Interakt Webhook] Auto-creating new lead for phone ${phone}`);
          const newLeadData = {
            name: customerName,
            phone: phone,
            source: 'social_media',
            department: targetDepartment,
            problem: `[Interakt Message] ${messageText}`,
            status: 'new'
          };
          
          await leadService.createLead(newLeadData, defaultAdmin ? defaultAdmin._id : null, 'admin');
        } else {
          console.log(`[Interakt Webhook] Adding note to existing lead ${lead._id}`);
          lead.notes.push({
            text: `[Interakt Message] ${messageText}`,
            direction: 'inbound',
          });
          await lead.save();
        }
      }
    } else {
      console.log(`[Interakt Webhook] Received unhandled event: ${payload.entityType || payload.type}`);
    }
  } catch (error) {
    console.error(`[Interakt Webhook Error]`, error);
  }

  // Always return 200 OK to acknowledge receipt of the webhook to Interakt
  res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, null, 'Webhook received successfully'));
});

/**
 * Send a WhatsApp message to a lead via Interakt
 */
const sendMessage = catchAsync(async (req, res) => {
  const { leadId, message, templateName, languageCode, useStandardChat } = req.body;

  if (!leadId) {
    return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'leadId is required'));
  }

  const lead = await Lead.findById(leadId);
  if (!lead) {
    return res.status(httpStatus.NOT_FOUND).json(new ApiResponse(httpStatus.NOT_FOUND, null, 'Lead not found'));
  }

  let mediaUrl = null;

  // Handle file upload if present
  if (req.file) {
    try {
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'interakt-media',
            resource_type: 'auto'
          },
          (error, result) => {
            if (error) return reject(new Error('Cloudinary upload failed'));
            resolve(result);
          }
        );
        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
      });
      mediaUrl = uploadResult.secure_url;
    } catch (error) {
      console.error('[Cloudinary Error]', error);
      return res.status(httpStatus.INTERNAL_SERVER_ERROR).json(new ApiResponse(httpStatus.INTERNAL_SERVER_ERROR, null, 'Failed to upload media'));
    }
  }

  // Send WhatsApp via Interakt
  let interaktResult = null;
  try {
    if (mediaUrl || useStandardChat === 'true' || useStandardChat === true) {
      // Use standard chat message API for attachments
      interaktResult = await sendInteraktChatMessage({
        phone: lead.phone,
        messageText: message || '',
        mediaUrl: mediaUrl
      });
    } else {
      // Use standard template API
      if (!message) {
        return res.status(httpStatus.BAD_REQUEST).json(new ApiResponse(httpStatus.BAD_REQUEST, null, 'message is required for templates'));
      }
      interaktResult = await sendWhatsAppMessage({
        phone: lead.phone,
        messageText: message,
        templateName,
        languageCode,
      });
    }
  } catch (err) {
    console.error('[Interakt] sendMessage failed:', err?.response?.data || err.message);
    // Don't block — still save the note so staff have a record
  }

  // Save outbound note
  const sentBy = req.user?._id || null;
  
  let noteText = message || '';
  if (mediaUrl) {
    noteText = `[Attached Media: ${mediaUrl}] ${noteText}`;
  }

  lead.notes.push({
    text: noteText,
    createdBy: sentBy,
    direction: 'outbound',
  });
  await lead.save();

  const savedNote = lead.notes[lead.notes.length - 1];
  return res.status(httpStatus.OK).json(new ApiResponse(httpStatus.OK, { note: savedNote, interaktResult }, 'Message sent'));
});

export default {
  handleWebhook,
  sendMessage,
  testWebhook: catchAsync(async (req, res) => {
    let lead = await Lead.findOne({ phone: "8888888888" });
    const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }).select('_id').lean();
    if (!lead) {
      const newLeadData = {
        name: `WhatsApp Lead (8888888888)`,
        phone: "8888888888",
        source: 'social_media',
        problem: `[Interakt Message] TEST`,
        status: 'new'
      };
      lead = await leadService.createLead(newLeadData, defaultAdmin ? defaultAdmin._id : null, 'admin');
      res.status(200).json({ success: true, message: "Lead CREATED", lead });
    } else {
      res.status(200).json({ success: true, message: "Lead ALREADY EXISTS", lead });
    }
  }),
  latestLeads: catchAsync(async (req, res) => {
    const leads = await Lead.find({ source: 'social_media' }).sort({ createdAt: -1 }).limit(10).lean();
    res.status(200).json({ success: true, leads });
  })
};
