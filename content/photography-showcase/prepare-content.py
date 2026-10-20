from pathlib import Path
import json, copy
ROOT=Path(__file__).resolve().parents[2]
old=json.loads((ROOT/'content/clinical-photography/course.json').read_text())
def p(text): return {'type':'paragraph','content':[{'type':'text','text':text}]}
def h(text,level=2): return {'type':'heading','attrs':{'level':level},'content':[{'type':'text','text':text}]}
def ul(items):return {'type':'bulletList','content':[{'type':'listItem','content':[p(x)]} for x in items]}
def doc(*nodes):return {'type':'doc','content':list(nodes)}
modules=['01 · The repeatable workflow','02 · Camera confidence','03 · Consistent light & framing','04 · The five-view model sequence','05 · Review, organise & hand over','06 · Your portfolio challenge']
titles=['Your first frame: a baseline worth improving','Permission and a clean working sequence','Build your kit, then write the setup card','Sharp where it matters: exposure and focus','One light setup, believable colour','Same subject, same geometry','Frontal and lateral views: build the sequence','Mirror views: make orientation unmistakable','The 60-second quality check','From memory card to a traceable image set','Portfolio challenge: capture, critique, repeat','Your next session: make improvement repeatable']
cases=[
('A repeat visit, a different picture','A colleague hands you two model photographs. One fills the frame; the other was taken further away. The shape appears different. Before comparing the subject, ask whether the capture conditions match. Recreate the original distance, orientation and framing, then make a new comparison. Your first improvement is controlling the process, not changing the subject.'),
('The image has a new purpose','A training photograph has been approved for an internal session. Someone now asks to use it in public advertising. Treat that as a separate decision: check the permitted purpose, the academy approval process and the applicable local requirements before sharing. For every activity in this course, use a model and a fictional identifier.'),
('The kit that nobody can reproduce','The first team member records only the camera model. The second cannot reproduce the frame. Add lens, working distance or magnification, lighting position, exposure and white-balance method. A setup card records what actually worked with your equipment; it is not a universal prescription.'),
('Bright does not mean sharp','Frame A is bright, but only the near edge of the model is sharp. Frame B is slightly darker and has useful detail throughout the intended area. Start by reviewing focus, movement and depth of field. Change one variable, take another frame and compare at the same viewing size. Do not try to repair missing detail by increasing brightness.'),
('The yellow image','A model looks neutral in one room and warm in another. Before editing its colour, check whether room lighting or the light source changed and whether the white-balance method was documented. Repeat with a controlled setup and a suitable reference. A pleasant-looking colour is not proof of colour accuracy.'),
('An impressive but unfair comparison','The second image was made closer to the model and from a slightly higher angle. Both frames are sharp, yet they cannot establish a reliable change in shape. Match camera height, subject orientation, distance and framing before comparing. Keep the original files and write down the mismatch.'),
('Five files, one missing view','Your folder contains five sharp images, but two are the same lateral view. Count coverage rather than files: frontal, right lateral, left lateral, upper occlusal and lower occlusal. Use the subject-side convention and your index to avoid silently reversing right and left.'),
('A reflected image with no label','A colleague cannot tell whether a mirror view was flipped. Do not guess. Use the capture record and your agreed orientation convention, then document any transformation in a derived copy. Keep the source image intact. If orientation remains unresolved, repeat the model capture.'),
('Choose the best next action','The upper arch frame is well exposed, but the intended area is partly hidden. The useful next step is to address the obstruction and recapture the model view. Renaming the file, adding contrast or sharpening cannot restore information that was never recorded.'),
('The file named final-final-2','A handoff contains a polished JPEG but no original or capture notes. Create a traceable set: an unchanged original, a separately named derived copy when needed, and a short index describing the view, orientation and transformation. Use the fictional model ID in this course, not a patient name.'),
('A portfolio that shows learning','Produce a baseline and improved version of one view, plus the complete five-view model series. Include a setup card and a quality review. Explain one deliberate change and one remaining limitation. This is a self-review exercise; the software does not analyse photographs or provide faculty grading.'),
('Make the change survive Monday','Your first session went well. Write a one-page routine someone else could follow: setup, capture order, review gate and file handoff. Name the one improvement you will test next time. Keep that variable separate so you can explain why the next set is better.')]
lessons=[]
for n,source in enumerate(old['lessons']):
    item=copy.deepcopy(source); item['module']=modules[n//2];item['title']=titles[n]
    nodes=item['richContent']['content']
    first_ref=next((i for i,node in enumerate(nodes) if node.get('type')=='heading' and any(t.get('text','').lower()=='further reading' for t in node.get('content',[]))),len(nodes))
    del nodes[first_ref:]
    for node in nodes:
        for run in node.get('content',[]):
            if 'text' in run:
                run['text']=run['text'].replace('Download the workbook from the optional Resources lesson', 'Download Field Guide & Practice Workbook from the opening module')
    # Keep the substantive model-based teaching, tighten the presentation edition introduction.
    if n==0:
        for node in nodes:
            if node.get('type')=='paragraph':
                text=''.join(t.get('text','') for t in node.get('content',[]))
                if 'complete course review edition' in text:
                    node['content'][0]['text']='Demonstration edition for academy review. Practise on a non-patient model. This course carries no approved education credits; clinical use needs academy faculty review.'
    # Worked decisions are original teaching examples, not patient cases.
    insert=next((i for i,node in enumerate(nodes) if node.get('type')=='heading' and any(t.get('text','').lower()=='try it' for t in node.get('content',[]))),len(nodes))
    nodes[insert:insert]=[h('Worked example: '+cases[n][0]),p(cases[n][1])]
    if n==0:
        nodes[1:1]=[h('Your finish line'),p('By the end, you will have a documented setup, a five-view model portfolio, a before-and-after improvement pair and a handoff checklist. Download the visual workbook in this module. Use its diagrams and worksheets as you work through the six stages.')]
    item['freePreview']=n in [0,1,2]
    lessons.append(item)
quiz=copy.deepcopy(old['quiz'])
quiz['questions'][-2]={'id':'showcase-15','prompt':'Your colleague must reproduce your improved model image tomorrow. Which handoff is most useful?','options':['The edited image alone','The camera price and brand','The setup card, view index, original files and review notes','An unlabeled screenshot'],'correct':2}
quiz['questions'][-1]={'id':'showcase-16','prompt':'You changed the lighting, framing and exposure at once. The next image looks better. What can you conclude?','options':['Exactly which change caused the improvement','Only that the combined setup changed the result; isolate variables in the next test','That the same settings work for every camera','That the original image can be discarded'],'correct':1}
refs=[r for r in old['references'] if r['id'] in ['aperture','iso','wb']]
refs += [{'id':'consent-current','title':'GDC: How patient consent can help build trust and confidence (UK context)','url':'https://www.gdc-uk.org/news-blogs/blog/detail/blogs/2026/02/24/how-patient-consent-can-help-build-trust-and-confidence'},{'id':'records-current','title':'GDC: Dental record keeping (UK context)','url':'https://www.gdc-uk.org/news-blogs/blog/detail/blogs/2024/06/19/dental-record-keeping-what-is-professional-reasonable-and-in-the-interest-of-patients'}]
# Source reading is separate from the original scenarios and practice tasks.
for n,item in enumerate(lessons):
    sources=refs[:3] if n in [2,3,4] else refs[3:]
    item['sources']=[r['id'] for r in sources]
    item['richContent']['content'] += [h('Further reading')]+[{'type':'paragraph','content':[{'type':'text','text':r['title'],'marks':[{'type':'link','attrs':{'href':r['url']}}]}]} for r in sources]
summary='Build a photography routine your whole team can repeat. Six practical modules take you from a first model capture to a consistent five-view portfolio, with a visual workbook, real decisions to practise and a final knowledge assessment.'
objectives=['Build and document a camera-and-light setup another team member can reproduce.','Identify the difference between focus, lighting, colour and framing problems.','Capture and label a five-view dental model sequence consistently.','Use a quality checklist to decide what to keep, repeat or investigate.','Preserve original files and make a traceable image handoff.','Complete a model portfolio and explain the changes that improved it.']
catalog=doc(p('A clear record starts with a repeatable process.'),h('From first frame to a portfolio you can explain'),p(summary),h('Your finish line'),p('Leave with a reusable setup card, a complete five-view model portfolio, an improvement pair and a file handoff you can explain to a colleague.'),h('A practical path through six modules'),ul([f'{modules[i][5:]} — {titles[i*2]}; {titles[i*2+1]}.' for i in range(6)]),h('Learn it. Try it. Review it.'),p('Each lesson combines a concise explanation, a worked decision and a practical task. Use a dental model or another non-patient object, record your settings in the workbook, and compare your baseline with an improved image. Your portfolio stays with you; there is no patient-image upload.'),h('What is included'),ul(['12 substantive lessons, organised into six modules.','An illustrated 16-page field guide and practical workbook.','A five-view portfolio challenge with a self-review rubric.','A 16-question scenario-based assessment: 80% pass mark, up to three attempts.','180 days of course access in this demonstration.']),h('Try the first module free'),p('Read the two opening lessons and explore the entire visual workbook before enrolling. The kit-and-setup lesson is also free. You can inspect every module and lesson title on this page.'),h('Who it is for'),p('Dental professionals and team members who want a consistent photographic workflow. Start with a camera or phone for the first exercise; a suitable camera/lens and lighting setup is needed to explore the later close-up exercises. Check equipment-specific settings in its manual.'),h('How long to allow'),p('Plan approximately four hours including model practice, workbook activities and the final assessment. Learn at your own pace and return to your saved reading position.'),h('Demonstration edition'),p('Created for the academy platform presentation. All activities use non-patient models. The display price is a demo price; no approved education credits are claimed. Academy faculty and local policy review are needed before clinical delivery. The final knowledge test is scored automatically; the portfolio is self-reviewed.'))
course={'key':'photography-showcase-2026-10','title':'Clinical Photography: From First Frame to Portfolio','specialty':'Clinical photography','summary':summary,'price':249900,'accessDays':180,'minutes':240,'objectives':objectives,'modules':modules,'lessons':lessons,'quiz':quiz,'catalogDetails':catalog,'references':refs,'workbook':{'title':'Field Guide & Practice Workbook','file':'photography-portfolio-workbook.pdf'}}
(ROOT/'content/photography-showcase/course.json').write_text(json.dumps(course,ensure_ascii=False,indent=2)+'\n')
print('Prepared 12 lessons, 6 modules, 16 assessment questions and catalog content.')
