import videojs from 'video.js';
import { requestPlayreadyLicense } from './playready';
import window from 'global/window';
import {uint8ArrayToString, mergeAndRemoveNull} from './utils';
import {httpResponseHandler} from './http-handler.js';
import {
  defaultGetCertificate as defaultFairplayGetCertificate,
  defaultGetLicense as defaultFairplayGetLicense,
  defaultGetContentId as defaultFairplayGetContentId
} from './fairplay';

const getIsEdgeLegacy = () => {
  return window.navigator && window.navigator.userAgent && window.navigator.userAgent.indexOf('Edge/') > -1;
};

// https://github.com/Dash-Industry-Forum/dash.js/blob/042e07df10175d2334db3158286768f34eb960c8/src/streaming/protection/controllers/ProtectionController.js#L166
const parsePSSH = data => {
  if (data === null || data === undefined) {
    return [];
  }

  // data.buffer first for Uint8Array support
  const dv = new DataView(data.buffer || data);
  const done = false;
  const pssh = {};

  // TODO: Need to check every data read for end of buffer
  let byteCursor = 0;
  let systemID;

  while (!done) {
    // let psshDataSize;

    const boxStart = byteCursor;

    if (byteCursor >= dv.buffer.byteLength) {
      break;
    }

    /* Box size */
    const size = dv.getUint32(byteCursor);
    const nextBox = byteCursor + size;

    byteCursor += 4;

    /* Verify PSSH */
    if (dv.getUint32(byteCursor) !== 0x70737368) {
      byteCursor = nextBox;
      continue;
    }
    byteCursor += 4;

    /* Version must be 0 or 1 */
    const version = dv.getUint8(byteCursor);

    if (version !== 0 && version !== 1) {
      byteCursor = nextBox;
      continue;
    }
    byteCursor++;

    /* skip flags */
    byteCursor += 3;

    // 16-byte UUID/SystemID
    systemID = '';
    let i;
    let val;

    for (i = 0; i < 4; i++) {
      val = dv.getUint8(byteCursor + i).toString(16);
      systemID += val.length === 1 ? '0' + val : val;
    }
    byteCursor += 4;
    systemID += '-';
    for (i = 0; i < 2; i++) {
      val = dv.getUint8(byteCursor + i).toString(16);
      systemID += val.length === 1 ? '0' + val : val;
    }
    byteCursor += 2;
    systemID += '-';
    for (i = 0; i < 2; i++) {
      val = dv.getUint8(byteCursor + i).toString(16);
      systemID += val.length === 1 ? '0' + val : val;
    }
    byteCursor += 2;
    systemID += '-';
    for (i = 0; i < 2; i++) {
      val = dv.getUint8(byteCursor + i).toString(16);
      systemID += val.length === 1 ? '0' + val : val;
    }
    byteCursor += 2;
    systemID += '-';
    for (i = 0; i < 6; i++) {
      val = dv.getUint8(byteCursor + i).toString(16);
      systemID += val.length === 1 ? '0' + val : val;
    }
    byteCursor += 6;

    systemID = systemID.toLowerCase();

    /* PSSH Data Size */
    // psshDataSize = dv.getUint32(byteCursor);
    byteCursor += 4;

    /* PSSH Data */
    pssh[systemID] = dv.buffer.slice(boxStart, nextBox);
    byteCursor = nextBox;
  }

  return pssh[systemID];
};

// TODO:
// var arrayToString = buffer => {
//   const uint8array = new Uint8Array(buffer);
//   return String.fromCharCode.apply(null, uint8array);
// };

// var extractUuid = initData => {
//   const string = arrayToString(initData);
//   console.log('extractUuid() string:', string);
//   // "skd://{ContentID}" -> "{ContentID}".
//   const skd = string.replace(/^.*:\/\//, '');
//   const uuid = skd.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
//   return uuid;
// };

// let enc = undefined;
// var formatInitDataForFairPlay = function formatInitDataForFairPlay(initData) {
//   if (!enc) {
//     enc = new TextEncoder();
//   }
//   var uuid = extractUuid(initData);
//   var string = `skd://${uuid}`;
//   console.log('formatInitDataForFairPlay() string:', string);

//   return enc.encode(string).buffer;
// };

const isFairplayKeySystem = (str) => str.startsWith('com.apple.fps');

/**
 * Returns an array of MediaKeySystemConfigurationObjects provided in the keySystem
 * options.
 *
 * @see {@link https://www.w3.org/TR/encrypted-media/#dom-mediakeysystemconfiguration|MediaKeySystemConfigurationObject}
 *
 * @param {Object} keySystemOptions
 *        Options passed into videojs-contrib-eme for a specific keySystem
 * @return {Object[]}
 *         Array of MediaKeySystemConfigurationObjects
 */
export const getSupportedConfigurations = (keySystem, keySystemOptions) => {
  if (keySystemOptions.supportedConfigurations) {
    return keySystemOptions.supportedConfigurations;
  }

  const isFairplay = isFairplayKeySystem(keySystem);
  const supportedConfiguration = {};
  const initDataTypes = keySystemOptions.initDataTypes ||
    // fairplay requires an explicit initDataTypes
    (isFairplay ? ['sinf'] : null);
  const audioContentType = keySystemOptions.audioContentType;
  const audioRobustness = keySystemOptions.audioRobustness;
  const videoContentType = keySystemOptions.videoContentType ||
    // fairplay requires an explicit videoCapabilities/videoContentType
    (isFairplay ? 'video/mp4' : null);
  const videoRobustness = keySystemOptions.videoRobustness;
  const persistentState = keySystemOptions.persistentState;

  if (audioContentType || audioRobustness) {
    supportedConfiguration.audioCapabilities = [
      Object.assign(
        {},
        (audioContentType ? { contentType: audioContentType } : {}),
        (audioRobustness ? { robustness: audioRobustness } : {})
      )
    ];
  }

  if (videoContentType || videoRobustness) {
    supportedConfiguration.videoCapabilities = [
      Object.assign(
        {},
        (videoContentType ? { contentType: videoContentType } : {}),
        (videoRobustness ? { robustness: videoRobustness } : {})
      )
    ];
  }

  if (persistentState) {
    supportedConfiguration.persistentState = persistentState;
  }

  if (initDataTypes) {
    supportedConfiguration.initDataTypes = initDataTypes;
  }

  return [supportedConfiguration];
};

export const getSupportedKeySystem = (keySystems) => {
  // As this happens after the src is set on the video, we rely only on the set src (we
  // do not change src based on capabilities of the browser in this plugin).

  let promise;

  Object.keys(keySystems).forEach((keySystem) => {
    const supportedConfigurations = getSupportedConfigurations(keySystem, keySystems[keySystem]);

    if (!promise) {
      promise =
        window.navigator.requestMediaKeySystemAccess(keySystem, supportedConfigurations);
    } else {
      promise = promise.catch((e) =>
        window.navigator.requestMediaKeySystemAccess(keySystem, supportedConfigurations));
    }
  });

  return promise;
};

export const makeNewRequest = (player, requestOptions) => {
  const {
    mediaKeys,
    initDataType,
    initData,
    options,
    getLicense,
    removeSession,
    addKeySession,
    eventBus,
    contentId
  } = requestOptions;

  const keySession = mediaKeys.createSession();

  eventBus.trigger('keysessioncreated');

  player.on('dispose', () => {
    keySession.close();
  });

  addKeySession(initData, keySession);

  return new Promise((resolve, reject) => {

    const messageHandler = (event) => {

      // all other types will be handled by keystatuseschange
      if (event.messageType !== 'license-request' && event.messageType !== 'license-renewal') {
        return;
      }

      getLicense(options, event.message, contentId)
        .then((license) => {
          resolve(keySession.update(license));
        })
        .catch((err) => {
          reject(err);
        });
    };

    keySession.addEventListener('message', messageHandler, false);
    keySession.messageHandler = messageHandler;

    const keyStatusChangeHandler = (event) => {

      let expired = false;

      // based on https://www.w3.org/TR/encrypted-media/#example-using-all-events
      keySession.keyStatuses.forEach((status, keyId) => {
        // Trigger an event so that outside listeners can take action if appropriate.
        // For instance, the `output-restricted` status should result in an
        // error being thrown.
        eventBus.trigger({
          keyId,
          status,
          target: keySession,
          type: 'keystatuschange'
        });
        switch (status) {
        case 'expired':
          // If one key is expired in a session, all keys are expired. From
          // https://www.w3.org/TR/encrypted-media/#dom-mediakeystatus-expired, "All other
          // keys in the session must have this status."
          expired = true;
          break;
        case 'internal-error':
          const message =
            'Key status reported as "internal-error." Leaving the session open since we ' +
            'don\'t have enough details to know if this error is fatal.';

          // "This value is not actionable by the application."
          // https://www.w3.org/TR/encrypted-media/#dom-mediakeystatus-internal-error
          videojs.log.warn(message, event);
          break;
        }
      });

      if (expired) {
        // Close session and remove it from the session list to ensure that a new
        // session can be created.
        //
        // TODO convert to videojs.log.debug and add back in
        // https://github.com/videojs/video.js/pull/4780
        // videojs.log.debug('Session expired, closing the session.');
        keySession.close().then(() => {
          removeSession(initData);
          makeNewRequest(player, requestOptions);
        });
      }
    };

    keySession.addEventListener('keystatuseschange', keyStatusChangeHandler, false);
    keySession.keyStatusChangeHandler = keyStatusChangeHandler;

    const parsedInitData = getIsEdgeLegacy() ? parsePSSH(initData) : initData;

    keySession.generateRequest(initDataType, parsedInitData).catch(() => {
      reject('Unable to create or initialize key session');
    });
  });
};

/*
 * Creates a new media key session if media keys are available, otherwise queues the
 * session creation for when the media keys are available.
 *
 * @see {@link https://www.w3.org/TR/encrypted-media/#dom-mediakeysession|MediaKeySession}
 * @see {@link https://www.w3.org/TR/encrypted-media/#dom-mediakeys|MediaKeys}
 *
 * @function addSession
 * @param {Object} video
 *        Target video element
 * @param {string} initDataType
 *        The type of init data provided
 * @param {Uint8Array} initData
 *        The media's init data
 * @param {Object} options
 *        Options provided to the plugin for this key system
 * @param {function()} [getLicense]
 *        User provided function to retrieve a license
 * @param {function()} removeSession
 *        Function to remove the persisted session on key expiration so that a new session
 *        may be created
 * @param {Object} eventBus
 *        Event bus for any events pertinent to users
 * @return {Promise}
 *         A resolved promise if session is waiting for media keys, or a promise for the
 *         session creation if media keys are available
 */
export const addSession = ({
  player,
  video,
  initDataType,
  initData,
  options,
  getLicense,
  contentId,
  removeSession,
  addKeySession,
  eventBus
}) => {
  const sessionData = {
    initDataType,
    initData,
    options,
    getLicense,
    removeSession,
    addKeySession,
    eventBus,
    contentId
  };

  if (video.mediaKeysObject) {
    sessionData.mediaKeys = video.mediaKeysObject;
    return makeNewRequest(player, sessionData);
  }

  video.pendingSessionData.push(sessionData);

  return Promise.resolve();
};

/*
 * Given media keys created from a key system access object, check for any session data
 * that was queued and create new sessions for each.
 *
 * @see {@link https://www.w3.org/TR/encrypted-media/#dom-mediakeysystemaccess|MediaKeySystemAccess}
 * @see {@link https://www.w3.org/TR/encrypted-media/#dom-mediakeysession|MediaKeySession}
 * @see {@link https://www.w3.org/TR/encrypted-media/#dom-mediakeys|MediaKeys}
 *
 * @function addPendingSessions
 * @param {Object} video
 *        Target video element
 * @param {string} [certificate]
 *        The server certificate (if used)
 * @param {Object} createdMediaKeys
 *        Media keys to use for session creation
 * @return {Promise}
 *         A promise containing new session creations and setting of media keys on the
 *         video object
 */
export const addPendingSessions = ({
  player,
  video,
  certificate,
  createdMediaKeys
}) => {
  // save media keys on the video element to act as a reference for other functions so
  // that they don't recreate the keys
  video.mediaKeysObject = createdMediaKeys;
  const promises = [];

  if (certificate) {
    promises.push(createdMediaKeys.setServerCertificate(certificate));
  }

  for (let i = 0; i < video.pendingSessionData.length; i++) {
    const data = video.pendingSessionData[i];

    promises.push(makeNewRequest(player, {
      mediaKeys: video.mediaKeysObject,
      initDataType: data.initDataType,
      initData: data.initData,
      options: data.options,
      getLicense: data.getLicense,
      removeSession: data.removeSession,
      eventBus: data.eventBus,
      contentId: data.contentId
    }));
  }

  video.pendingSessionData = [];

  promises.push(video.setMediaKeys(createdMediaKeys));

  return Promise.all(promises);
};

const defaultPlayreadyGetLicense = (keySystemOptions) => (emeOptions, keyMessage, callback) => {
  requestPlayreadyLicense(keySystemOptions, keyMessage, emeOptions, callback);
};

export const defaultGetLicense = (keySystemOptions) => (emeOptions, keyMessage, callback) => {
  const headers = mergeAndRemoveNull(
    {'Content-type': 'application/octet-stream'},
    emeOptions.emeHeaders,
    keySystemOptions.licenseHeaders
  );

  videojs.xhr({
    uri: keySystemOptions.url,
    method: 'POST',
    responseType: 'arraybuffer',
    body: keyMessage,
    headers
  }, httpResponseHandler(callback, true));
};

const promisifyGetLicense = (keySystem, getLicenseFn, eventBus, initData) => {
  return (emeOptions, keyMessage, contentId) => {
    return new Promise((resolve, reject) => {
      let mpdXml;
      let kId;

      try {
        mpdXml = eventBus.vhs ? eventBus.vhs.playlists.masterXml_ : '';
        const reg = new RegExp(
          /<AdaptationSet(.*?ContentProtection.*?)<\/AdaptationSet>/,
          'gs'
        );
        const adaptationSetGroups = mpdXml.match(reg) || [];
        const initDataString = window.btoa(String.fromCharCode(...new Uint8Array(initData))).slice(0, 731) || '';
        // '731' is to slice `cenc:pssh` part of initData on PlayReady, Widevine pssh length won't exceed 731

        kId = adaptationSetGroups.reduce((result, data, index, array) => {
          if (data.includes(initDataString)) {
            // break the iterator
            array.splice(1);
            return data && data.match(/default_KID="(.+)"/)[1];
          }
          return result;
        }, null);
      } catch (e) {
        //
      }

      const callback = function(err, license) {
        if (eventBus) {
          eventBus.trigger('licenserequestattempted');
        }
        if (err) {
          reject(err);
          return;
        }

        resolve(license);
      };

      if (isFairplayKeySystem(keySystem)) {
        getLicenseFn(emeOptions, contentId, new Uint8Array(keyMessage), callback);
      } else {
        getLicenseFn(emeOptions, keyMessage, callback, kId);
      }
    });
  };
};

const standardizeKeySystemOptions = (keySystem, keySystemOptions) => {
  if (typeof keySystemOptions === 'string') {
    keySystemOptions = { url: keySystemOptions };
  }

  if (!keySystemOptions.url && keySystemOptions.licenseUri) {
    keySystemOptions.url = keySystemOptions.licenseUri;
  }

  if (!keySystemOptions.url && !keySystemOptions.getLicense) {
    throw new Error(`Missing url/licenseUri or getLicense in ${keySystem} keySystem configuration.`);
  }

  const isFairplay = isFairplayKeySystem(keySystem);

  if (isFairplay && keySystemOptions.certificateUri && !keySystemOptions.getCertificate) {
    keySystemOptions.getCertificate = defaultFairplayGetCertificate(keySystemOptions);
  }

  if (isFairplay && !keySystemOptions.getCertificate) {
    throw new Error(`Missing getCertificate or certificateUri in ${keySystem} keySystem configuration.`);
  }

  if (isFairplay && !keySystemOptions.getContentId) {
    keySystemOptions.getContentId = defaultFairplayGetContentId;
  }

  if (keySystemOptions.url && !keySystemOptions.getLicense) {
    if (keySystem === 'com.microsoft.playready') {
      keySystemOptions.getLicense = defaultPlayreadyGetLicense(keySystemOptions);
    } else if (isFairplay) {
      keySystemOptions.getLicense = defaultFairplayGetLicense(keySystemOptions);
    } else {
      keySystemOptions.getLicense = defaultGetLicense(keySystemOptions);
    }
  }

  return keySystemOptions;
};

export const standard5July2016 = ({
  player,
  video,
  initDataType,
  initData,
  keySystemAccess,
  options,
  removeSession,
  addKeySession,
  eventBus
}) => {
  let keySystemPromise = Promise.resolve();
  const keySystem = keySystemAccess.keySystem;
  let keySystemOptions;

  // try catch so that we return a promise rejection
  try {
    keySystemOptions = standardizeKeySystemOptions(
      keySystem,
      options.keySystems[keySystem]
    );
  } catch (e) {
    return Promise.reject(e);
  }

  const contentId = keySystemOptions.getContentId ?
    keySystemOptions.getContentId(options, uint8ArrayToString(initData)) : null;

  if (typeof video.mediaKeysObject === 'undefined') {
    // Prevent entering this path again.
    video.mediaKeysObject = null;

    // Will store all initData until the MediaKeys is ready.
    video.pendingSessionData = [];

    let certificate;

    keySystemPromise = new Promise((resolve, reject) => {
      // save key system for adding sessions
      video.keySystem = keySystem;

      if (!keySystemOptions.getCertificate) {
        resolve(keySystemAccess);
        return;
      }

      keySystemOptions.getCertificate(options, (err, cert) => {
        if (err) {
          reject(err);
          return;
        }

        certificate = cert;

        resolve();
      });
    }).then(() => {
      return keySystemAccess.createMediaKeys();
    }).then((createdMediaKeys) => {
      return addPendingSessions({
        player,
        video,
        certificate,
        createdMediaKeys
      });
    }).catch((err) => {
      // if we have a specific error message, use it, otherwise show a more
      // generic one
      if (err) {
        return Promise.reject(err);
      }
      return Promise.reject('Failed to create and initialize a MediaKeys object');
    });
  }

  return keySystemPromise.then(() => {
    // if key system has not been determined then addSession doesn't need getLicense
    const getLicense = video.keySystem ?
      promisifyGetLicense(keySystem, keySystemOptions.getLicense, eventBus, initData) : null;

    return addSession({
      player,
      video,
      initDataType,
      initData,
      options,
      getLicense,
      contentId,
      removeSession,
      addKeySession,
      eventBus
    });
  });
};
