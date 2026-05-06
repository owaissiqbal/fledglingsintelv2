/**
 * Skills Bootcamps commissioners ingest.
 *
 * gov.uk lists the 33 English local commissioning authorities (combined
 * authorities, county councils, unitaries) that hold Skills Bootcamps
 * budget and procure pre-employment programmes from local providers.
 *
 * Source: https://www.gov.uk/government/publications/skills-bootcamps-training-providers/list-of-skills-bootcamp-delivery-areas-and-contact-details
 *
 * For Fledglings, these are tier-1 ICP — they buy pre-employment bootcamp
 * content directly. Each entry comes with a direct-line skills team email,
 * which is harder gold than scraping a generic info@ inbox.
 *
 * We classify them as 'employer' type with source='skills_bootcamps' so the
 * UI can surface them as commissioners distinct from APAR Employer-Providers.
 */

import { eq, sql } from "drizzle-orm";
import { db, institutions } from "@/db";
import { log } from "./log";
import type { RunResult } from "./run";

type Commissioner = {
  region: string;
  name: string;
  email: string | null;
  website: string | null;
};

const COMMISSIONERS: Commissioner[] = [
  ["East of England", "Cambridgeshire & Peterborough Combined Authority", "skillsbootcamps@cambridgeshirepeterborough-ca.gov.uk", "https://cambridgeshirepeterborough-ca.gov.uk/what-we-deliver/skills/skills-bootcamps/"],
  ["East of England", "Essex County Council", "bootcamps@essex.gov.uk", "https://essexopportunities.co.uk/skills-bootcamps/"],
  ["East of England", "Hertfordshire County Council", "hopinto@hertfordshirefutures.co.uk", "https://hopinto.co.uk/skills-bootcamps/"],
  ["East of England", "Suffolk County Council", "SkillsBootCamp@Suffolk.gov.uk", "https://www.suffolk.gov.uk/business/supporting-employers-training-your-workforce/skills-bootcamps"],
  ["East Midlands", "East Midlands Combined County Authority", "SkillsBootcamp@eastmidlands-cca.gov.uk", "https://www.eastmidlands-cca.gov.uk/what-we-do/skills-and-employment/skills-bootcamps/"],
  ["East Midlands", "Lincolnshire County Council", "skillsbootcamps@lincolnshire.gov.uk", "https://www.lincolnshire.gov.uk/grants-funding/skills-bootcamps"],
  ["East Midlands", "Leicester City Council", "regeneration.programmes@leicester.gov.uk", "https://leicesteremploymenthub.co.uk/skills-bootcamps/"],
  ["London", "Greater London Authority", "SkillsBootcamps@london.gov.uk", "https://www.london.gov.uk/programmes-strategies/jobs-and-skills/londoners-seeking-employability-skills/skills-bootcamps-londoners"],
  ["North East", "North East Combined Authority", "skills@northeast-ca.gov.uk", "https://www.northeast-ca.gov.uk/projects/skills-bootcamps"],
  ["North East", "Tees Valley Combined Authority", "business@teesvalley-ca.gov.uk", "https://teesvalley-ca.gov.uk/work/skills-support/skills-support-for-adults/skills-bootcamps/"],
  ["North West", "Cheshire East Council", "grants@cheshireandwarrington.com", "https://cheshireandwarrington.com/growth-and-skills/skills-and-education/skills-bootcamps/"],
  ["North West", "Cumberland Council", null, "https://www.enterprisingcumbria.org.uk/welcome-enterprising-cumbria"],
  ["North West", "Lancashire County Council", "SkillsBootcamps@lancashireskillshub.co.uk", "https://www.lancashireskillshub.co.uk/skillsbootcamps/"],
  ["North West", "Liverpool City Region Combined Authority", "skillsbootcamps@liverpoolcityregion-ca.gov.uk", "https://lcrbemore.co.uk/skillsbootcamps/"],
  ["South East", "Brighton & Hove City Council", "skillsbootcamps@brighton-hove.gov.uk", "https://adulteducation.brighton-hove.gov.uk/skills-bootcamps/"],
  ["South East", "Buckinghamshire County Council", "skills.bootcamps@buckinghamshire.gov.uk", "https://www.buckinghamshire.gov.uk/community-and-safety/skills-opportunities-and-employment/enrol-in-a-skills-bootcamp/"],
  ["South East", "East Sussex County Council", "SkillsBootcamps@eastsussex.gov.uk", "https://careerseastsussex.co.uk/information/adults/skills-bootcamps"],
  ["South East", "Hampshire County Council", "skills@hants.gov.uk", "https://www.hants.gov.uk/business/skillsbootcamp"],
  ["South East", "Kent County Council", "skills.bootcamp@kent.gov.uk", "https://www.kentadulteducation.co.uk/learning-with-us/skills-bootcamps/"],
  ["South East", "Oxfordshire County Council", "Skillsbootcamps@enterpriseoxfordshire.com", "https://www.enterpriseoxfordshireskills.com/individuals/skills-bootcamps/"],
  ["South East", "Portsmouth City Council (The Solent)", "solentgrowthpartnershipinfo@portsmouthcc.gov.uk", "https://www.solentgrowthpartnership.co.uk/courses/"],
  ["South East", "Surrey County Council", "skillsbootcamps@surreycc.gov.uk", "https://www.surreycc.gov.uk/schools-and-learning/post-16/skills-bootcamps"],
  ["South East", "Wokingham Council (Thames Valley)", "berkshireskillsbootcamps@thamesvalleyberkshire.co.uk", "https://www.berkshireopportunities.co.uk/skills-bootcamps/"],
  ["South East", "West Sussex County Council", "SkillsBootcamps@westsussex.gov.uk", "https://www.westsussex.gov.uk/education-children-and-families/skills-bootcamps/"],
  ["South West", "Cornwall Council", "peopleandskills@cornwall.gov.uk", "https://cornwall-opportunities.co.uk/skills-bootcamps/"],
  ["South West", "Devon County Council", "train4tomorrow@devon.gov.uk", "https://train4tomorrow.org.uk"],
  ["South West", "Somerset County Council", "hello@dstpn.co.uk", "https://dstpn.co.uk/skills-bootcamps/"],
  ["South West", "Wiltshire County Council", "skillsbootcamps@wiltshire.gov.uk", "https://workwiltshire.co.uk/skills-bootcamps/"],
  ["South West", "West of England Combined Authority", "skillsbootcamps@westofengland-ca.gov.uk", "https://www.westofengland-ca.gov.uk/what-we-do/employment-skills/skills-bootcamps/"],
  ["West Midlands", "Worcestershire County Council", "SkillsBootcamps@worcestershire.gov.uk", "https://careersworcs.co.uk/skillsbootcamps/"],
  ["Yorkshire and the Humber", "Hull City Council", "skills.bootcamp@hullcc.gov.uk", "https://hcctraining.ac.uk/bootcamps"],
  ["Yorkshire and the Humber", "South Yorkshire Combined Authority", "bootcamps@southyorkshire-ca.gov.uk", "https://www.southyorkshire-ca.gov.uk/skills-bootcamps"],
  ["Yorkshire and the Humber", "West Yorkshire Combined Authority", "skills.admin@westyorks-ca.gov.uk", null],
  ["Yorkshire and the Humber", "York and North Yorkshire Combined Authority", "support@ynygrowthhub.com", "https://ynygrowthhub.com/skills-bootcamps-in-york-and-north-yorkshire/"],
].map(([region, name, email, website]) => ({
  region: region as string,
  name: name as string,
  email: email as string | null,
  website: website as string | null,
}));

export async function ingestSkillsBootcamps(): Promise<RunResult> {
  let inserted = 0;
  let updated = 0;
  const now = new Date();

  for (const c of COMMISSIONERS) {
    // Match by name first (prevents duplicates if a council was already
    // ingested via APAR / GIAS as some other type).
    const existing = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.name, c.name))
      .limit(1);

    if (existing[0]) {
      await db
        .update(institutions)
        .set({
          type: "employer",
          generalEmail: c.email ?? undefined,
          website: c.website ?? undefined,
          region: c.region,
          source: "skills_bootcamps",
          inScope: true,
          updatedAt: now,
        })
        .where(eq(institutions.id, existing[0].id));
      updated++;
    } else {
      await db.insert(institutions).values({
        name: c.name,
        type: "employer",
        phase: "post_16",
        region: c.region,
        generalEmail: c.email,
        website: c.website,
        source: "skills_bootcamps",
        inScope: true,
      });
      inserted++;
    }
  }

  log.info(
    `skills_bootcamps: ${inserted} commissioners inserted, ${updated} existing rows updated`,
  );

  return {
    recordsSeen: COMMISSIONERS.length,
    recordsUpserted: inserted + updated,
    notes: `inserted=${inserted} updated=${updated}`,
  };
}
