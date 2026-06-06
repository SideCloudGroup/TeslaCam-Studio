const DashcamMp4 = (() => {
  const textDecoder = new TextDecoder();

  function readType(view, offset) {
    return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, 4));
  }

  function readBoxHeader(view, offset) {
    if (offset + 8 > view.byteLength) return null;
    let size = view.getUint32(offset);
    const type = readType(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > view.byteLength) return null;
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = view.byteLength - offset;
    }
    return { type, size, headerSize, start: offset, dataStart: offset + headerSize, end: offset + size };
  }

  function* boxes(view, start = 0, end = view.byteLength) {
    let offset = start;
    while (offset + 8 <= end) {
      const box = readBoxHeader(view, offset);
      if (!box || box.size < box.headerSize || box.end > end) break;
      yield box;
      offset = box.end;
    }
  }

  function findChild(view, parent, type) {
    for (const box of boxes(view, parent.dataStart, parent.end)) {
      if (box.type === type) return box;
    }
    return null;
  }

  function collectChildPath(view, rootType, path) {
    for (const root of boxes(view)) {
      if (root.type !== rootType) continue;
      let current = root;
      for (const type of path) {
        current = findChild(view, current, type);
        if (!current) break;
      }
      if (current) return current;
    }
    return null;
  }

  function parseStts(view, box) {
    if (!box) return [];
    const rows = [];
    let offset = box.dataStart + 4;
    if (offset + 4 > box.end) return rows;
    const count = view.getUint32(offset);
    offset += 4;
    for (let i = 0; i < count && offset + 8 <= box.end; i += 1) {
      rows.push({
        sampleCount: view.getUint32(offset),
        sampleDelta: view.getUint32(offset + 4)
      });
      offset += 8;
    }
    return rows;
  }

  function parseMdhdTimescale(view, box) {
    if (!box) return 30_000;
    const version = view.getUint8(box.dataStart);
    const offset = box.dataStart + (version === 1 ? 20 : 12);
    return offset + 4 <= box.end ? view.getUint32(offset) : 30_000;
  }

  function getDurationsMs(view) {
    const mdhd = collectChildPath(view, 'moov', ['trak', 'mdia', 'mdhd']);
    const stts = collectChildPath(view, 'moov', ['trak', 'mdia', 'minf', 'stbl', 'stts']);
    const timescale = parseMdhdTimescale(view, mdhd);
    const rows = parseStts(view, stts);
    const durations = [];
    for (const row of rows) {
      const durationMs = (row.sampleDelta / timescale) * 1000;
      for (let i = 0; i < row.sampleCount; i += 1) durations.push(durationMs);
    }
    return durations;
  }

  function removeEmulationPrevention(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 1) {
      if (i > 1 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) continue;
      out.push(bytes[i]);
    }
    return new Uint8Array(out);
  }

  function extractSeiPayload(nal) {
    const rbsp = removeEmulationPrevention(nal.subarray(1));
    let offset = 0;
    const payloads = [];
    while (offset < rbsp.length - 1) {
      let payloadType = 0;
      while (rbsp[offset] === 0xff && offset < rbsp.length) {
        payloadType += 255;
        offset += 1;
      }
      payloadType += rbsp[offset++] ?? 0;

      let payloadSize = 0;
      while (rbsp[offset] === 0xff && offset < rbsp.length) {
        payloadSize += 255;
        offset += 1;
      }
      payloadSize += rbsp[offset++] ?? 0;
      if (payloadSize <= 0 || offset + payloadSize > rbsp.length) break;

      if (payloadType === 5) {
        payloads.push(rbsp.subarray(offset, offset + payloadSize));
      }
      offset += payloadSize;
    }
    return payloads;
  }

  function looksLikeLengthPrefixed(view, start, end) {
    if (start + 5 > end) return false;
    const size = view.getUint32(start);
    return size > 0 && size < end - start && start + 4 + size <= end;
  }

  function* nalsFromMdat(view, box) {
    const start = box.dataStart;
    const end = box.end;
    if (looksLikeLengthPrefixed(view, start, end)) {
      let offset = start;
      while (offset + 5 <= end) {
        const size = view.getUint32(offset);
        offset += 4;
        if (size <= 0 || offset + size > end) break;
        yield new Uint8Array(view.buffer, view.byteOffset + offset, size);
        offset += size;
      }
      return;
    }

    const bytes = new Uint8Array(view.buffer, view.byteOffset + start, end - start);
    let last = -1;
    for (let i = 0; i < bytes.length - 4; i += 1) {
      const isStart = bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1));
      if (!isStart) continue;
      const prefix = bytes[i + 2] === 1 ? 3 : 4;
      if (last >= 0) yield bytes.subarray(last, i);
      last = i + prefix;
      i += prefix - 1;
    }
    if (last >= 0 && last < bytes.length) yield bytes.subarray(last);
  }

  function readVarint(bytes, state) {
    let result = 0;
    let shift = 0;
    while (state.offset < bytes.length) {
      const byte = bytes[state.offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    return result;
  }

  function hasBytes(bytes, state, count) {
    return state.offset + count <= bytes.length;
  }

  function skipField(bytes, state, wireType) {
    if (wireType === 0) readVarint(bytes, state);
    else if (wireType === 1) state.offset = Math.min(bytes.length, state.offset + 8);
    else if (wireType === 2) state.offset = Math.min(bytes.length, state.offset + readVarint(bytes, state));
    else if (wireType === 5) state.offset = Math.min(bytes.length, state.offset + 4);
    else state.offset = bytes.length;
  }

  function decodeMetadataAt(payload) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const state = { offset: 0 };
    const item = {};
    while (state.offset < payload.length) {
      const key = readVarint(payload, state);
      const field = key >> 3;
      const wireType = key & 0x07;
      const valueOffset = state.offset;
      if (key === 0) return null;
      if (field < 1 || field > 16) {
        skipField(payload, state, wireType);
        continue;
      }

      if (wireType === 0) {
        const value = readVarint(payload, state);
        if (field === 1) item.version = value;
        else if (field === 2) item.gear_state = value;
        else if (field === 3) item.frame_seq_no = value;
        else if (field === 7) item.blinker_on_left = Boolean(value);
        else if (field === 8) item.blinker_on_right = Boolean(value);
        else if (field === 9) item.brake_applied = Boolean(value);
        else if (field === 10) item.autopilot_state = value;
      } else if (wireType === 5) {
        if (!hasBytes(payload, state, 4)) return null;
        const value = view.getFloat32(valueOffset, true);
        state.offset += 4;
        if (field === 4) item.vehicle_speed_mps = value;
        else if (field === 5) item.accelerator_pedal_position = value;
        else if (field === 6) item.steering_wheel_angle = value;
      } else if (wireType === 1) {
        if (!hasBytes(payload, state, 8)) return null;
        const value = view.getFloat64(valueOffset, true);
        state.offset += 8;
        if (field === 11) item.latitude_deg = value;
        else if (field === 12) item.longitude_deg = value;
        else if (field === 13) item.heading_deg = value;
        else if (field === 14) item.linear_acceleration_mps2_x = value;
        else if (field === 15) item.linear_acceleration_mps2_y = value;
        else if (field === 16) item.linear_acceleration_mps2_z = value;
      } else {
        skipField(payload, state, wireType);
      }
    }

    if (Object.keys(item).length < 2) return null;
    return item;
  }

  function decodeMetadata(payload) {
    let best = null;
    let bestScore = 0;
    const maxPrefix = Math.min(32, payload.length - 2);
    for (let prefix = 0; prefix <= maxPrefix; prefix += 1) {
      const item = decodeMetadataAt(payload.subarray(prefix));
      if (!item) continue;
      const keys = Object.keys(item);
      const score = keys.length
        + (item.frame_seq_no !== undefined ? 4 : 0)
        + (item.vehicle_speed_mps !== undefined ? 3 : 0)
        + (item.steering_wheel_angle !== undefined ? 2 : 0);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return best;
  }

  function readTelemetry(buffer) {
    const view = new DataView(buffer);
    const durations = getDurationsMs(view);
    const telemetry = [];
    let frameIndex = 0;
    let elapsedMs = 0;

    for (const box of boxes(view)) {
      if (box.type !== 'mdat') continue;
      for (const nal of nalsFromMdat(view, box)) {
        const nalType = nal[0] & 0x1f;
        if (nalType === 6) {
          for (const payload of extractSeiPayload(nal)) {
            let metadata = null;
            try {
              metadata = decodeMetadata(payload);
            } catch {
              metadata = null;
            }
            if (metadata) telemetry.push({ ...metadata, timeMs: elapsedMs });
          }
        } else if (nalType === 1 || nalType === 5) {
          const duration = durations[frameIndex] ?? (1000 / 30);
          elapsedMs += duration;
          frameIndex += 1;
        }
      }
    }

    telemetry.sort((a, b) => a.timeMs - b.timeMs);
    return telemetry;
  }

  return { readTelemetry };
})();
